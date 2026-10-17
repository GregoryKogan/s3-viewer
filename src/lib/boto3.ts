import type { ChecksumCalculation, ChecksumValidation, SignatureVersion, AddressingStyle } from "@/types";

export interface SnippetValues {
  endpointUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  bucket: string;
  prefix: string;
  signatureVersion: SignatureVersion;
  addressingStyle: AddressingStyle;
  payloadSigning: boolean;
  requestChecksumCalculation: ChecksumCalculation;
  responseChecksumValidation: ChecksumValidation;
}

/**
 * The boto3 client that reproduces the current connection settings.
 *
 * This is the promise the app makes: copy these settings from working Python, or
 * copy this snippet back into Python, and it behaves the same.
 */
export function boto3Snippet(values: SnippetValues): string {
  const lines = ["import boto3", "from botocore.config import Config", "", "client = boto3.client("];
  lines.push(`    "s3",`);
  lines.push(`    endpoint_url="${values.endpointUrl}",`);
  if (values.region) lines.push(`    region_name="${values.region}",`);
  lines.push(`    aws_access_key_id="${values.accessKeyId}",`);
  const secret = values.secretAccessKey ? values.secretAccessKey : "<stored on this machine>";
  lines.push(`    aws_secret_access_key="${secret}",`);
  if (values.sessionToken) lines.push(`    aws_session_token="${values.sessionToken}",`);
  lines.push(`    config=Config(`);
  lines.push(`        signature_version="${values.signatureVersion}",`);
  lines.push(`        s3={`);
  lines.push(`            "addressing_style": "${values.addressingStyle}",`);
  lines.push(`            "payload_signing_enabled": ${values.payloadSigning ? "True" : "False"},`);
  lines.push(`        },`);
  lines.push(`        request_checksum_calculation="${values.requestChecksumCalculation}",`);
  lines.push(`        response_checksum_validation="${values.responseChecksumValidation}",`);
  lines.push(`    ),`);
  lines.push(")");
  lines.push("");
  lines.push(`# bucket: ${values.bucket}`);
  lines.push(`# prefix: ${values.prefix}`);
  return lines.join("\n");
}
