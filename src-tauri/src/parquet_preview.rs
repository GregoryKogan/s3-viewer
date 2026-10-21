//! Tabular preview for Parquet objects.
//!
//! Uses `parquet`'s low-level API on purpose: the Arrow reader would add a large
//! dependency and a long build for what is only ever a first-N-rows table.

use crate::error::{AppError, AppResult};
use crate::model::TablePreview;
use bytes::Bytes;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::Row;

/// A small, valid Parquet file. Used by the unit tests and written to
/// `e2e/fixtures/generated/table.parquet` so the end-to-end suite can upload it:
/// writing Parquet needs Arrow, which is a dev-dependency only.
#[cfg(test)]
pub fn fixture_bytes() -> Vec<u8> {
    use arrow::array::{Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use std::sync::Arc as StdArc;

    let schema = StdArc::new(Schema::new(vec![
        Field::new("name", DataType::Utf8, false),
        Field::new("count", DataType::Int64, false),
        Field::new("score", DataType::Float64, false),
    ]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            StdArc::new(StringArray::from(vec!["alpha", "beta", "gamma"])),
            StdArc::new(Int64Array::from(vec![1, 2, 3])),
            StdArc::new(Float64Array::from(vec![0.5, 1.25, 2.75])),
        ],
    )
    .expect("record batch");

    let mut buffer = Vec::new();
    {
        let mut writer = ArrowWriter::try_new(&mut buffer, schema, None).expect("writer");
        writer.write(&batch).expect("write batch");
        writer.close().expect("close writer");
    }
    buffer
}

/// Rows shown before the table is cut off. Enough to orient yourself, small
/// enough to cross the IPC boundary instantly.
pub const MAX_ROWS: usize = 200;
/// Columns shown; wider tables are truncated with a note.
pub const MAX_COLUMNS: usize = 60;

/// Parse the head of a Parquet file into a table.
pub fn preview(bytes: &[u8]) -> AppResult<TablePreview> {
    // `ChunkReader` is implemented for `Bytes` (and files), which is also why the
    // caller hands ownership over instead of a slice.
    let reader = SerializedFileReader::new(Bytes::from(bytes.to_vec()))
        .map_err(|e| AppError::msg(format!("not a readable Parquet file: {e}")))?;

    let metadata = reader.metadata();
    let file_metadata = metadata.file_metadata();
    let schema = file_metadata.schema_descr();
    let total_rows = metadata.file_metadata().num_rows();

    let mut columns: Vec<String> = schema
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    let mut truncated_columns = false;
    if columns.len() > MAX_COLUMNS {
        columns.truncate(MAX_COLUMNS);
        truncated_columns = true;
    }

    let iter = reader.get_row_iter(None).map_err(|e| {
        AppError::msg(format!(
            "cannot read rows from this Parquet file (unsupported encoding or type): {e}"
        ))
    })?;

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut truncated_rows = false;
    for row in iter {
        if rows.len() >= MAX_ROWS {
            truncated_rows = true;
            break;
        }
        match row {
            Ok(row) => rows.push(format_row(&row, columns.len())),
            Err(e) => {
                // A single unreadable row must not throw away everything read so
                // far; report it as a partial table instead.
                rows.push(vec![format!("<unreadable row: {e}>")]);
                truncated_rows = true;
                break;
            }
        }
    }

    Ok(TablePreview {
        columns,
        rows,
        total_rows,
        truncated_rows,
        truncated_columns,
    })
}

fn format_row(row: &Row, limit: usize) -> Vec<String> {
    let mut out = Vec::with_capacity(limit);
    for i in 0..limit {
        out.push(
            row.get_column_iter()
                .nth(i)
                .map(|(_, field)| render(field))
                .unwrap_or_default(),
        );
    }
    out
}

/// Parquet field -> the string the table cell shows. `Display` on the field
/// types is compact and lossless enough for a preview (byte arrays become
/// `[1, 2, 3]`, dates keep their ISO form, and so on).
fn render(field: &parquet::record::Field) -> String {
    use parquet::record::Field;
    match field {
        Field::Null => String::new(),
        Field::Str(value) => value.clone(),
        Field::Bytes(value) => String::from_utf8_lossy(value.data()).to_string(),
        other => other.to_string(),
    }
}

/// Cheap structural sniff so a Parquet file without the right extension still
/// gets the table preview: `PAR1` at both ends.
pub fn looks_like_parquet(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && &bytes[..4] == b"PAR1" && &bytes[bytes.len() - 4..] == b"PAR1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_sniff() {
        assert!(looks_like_parquet(b"PAR1xxxxPAR1"));
        assert!(!looks_like_parquet(b"PAR1xxxx"));
        assert!(!looks_like_parquet(b""));
        assert!(!looks_like_parquet(b"not a parquet file"));
    }

    #[test]
    fn reads_a_real_file_into_a_table() {
        let bytes = fixture_bytes();
        // Hand the same bytes to the end-to-end suite (gitignored path).
        let fixtures =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/fixtures/generated");
        if fixtures.is_dir() {
            let _ = std::fs::write(fixtures.join("table.parquet"), &bytes);
        }
        assert!(
            looks_like_parquet(&bytes),
            "fixture must carry the PAR1 magic"
        );

        let table = preview(&bytes).expect("fixture must parse");
        assert_eq!(table.columns, vec!["name", "count", "score"]);
        assert_eq!(table.rows.len(), 3);
        assert_eq!(table.rows[0][0], "alpha");
        assert!(
            table.rows[0][1].contains('1'),
            "count column: {:?}",
            table.rows[0]
        );
        assert!(
            table.rows[2][2].contains("2.75"),
            "score column: {:?}",
            table.rows[2]
        );
        assert_eq!(table.total_rows, 3);
        assert!(!table.truncated_rows);
        assert!(!table.truncated_columns);
    }

    #[test]
    fn garbage_is_rejected_with_a_message() {
        let error = preview(b"definitely not parquet").unwrap_err();
        let text = error.to_string();
        assert!(text.contains("Parquet"), "unhelpful error: {text}");
    }
}
