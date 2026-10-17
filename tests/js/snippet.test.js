import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { boto3Snippet } = await loadTs("src/lib/boto3.ts");

const base = {
  endpointUrl: "https://s3.example.com",
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "SECRET",
  bucket: "my-bucket",
  prefix: "some/path/",
  signatureVersion: "s3v4",
  addressingStyle: "virtual",
  payloadSigning: false,
  requestChecksumCalculation: "whenSupported",
  responseChecksumValidation: "whenSupported",
};

test("uses the exact boto3 argument names", () => {
  const snippet = boto3Snippet(base);
  assert.match(snippet, /import boto3/);
  assert.match(snippet, /from botocore\.config import Config/);
  assert.match(snippet, /boto3\.client\(/);
  assert.ok(snippet.includes('endpoint_url="https://s3.example.com"'));
  assert.ok(snippet.includes('region_name="us-east-1"'));
  assert.ok(snippet.includes('aws_access_key_id="AKIAEXAMPLE"'));
  assert.ok(snippet.includes('aws_secret_access_key="SECRET"'));
  assert.ok(snippet.includes('signature_version="s3v4"'));
  assert.ok(snippet.includes('"addressing_style": "virtual"'));
  assert.ok(snippet.includes('"payload_signing_enabled": False'));
});

test("includes both checksum switches, which botocore honours", () => {
  const snippet = boto3Snippet(base);
  assert.ok(snippet.includes('request_checksum_calculation="whenSupported"'));
  assert.ok(snippet.includes('response_checksum_validation="whenSupported"'));

  const strict = boto3Snippet({
    ...base,
    requestChecksumCalculation: "whenRequired",
    responseChecksumValidation: "whenRequired",
  });
  assert.ok(strict.includes('request_checksum_calculation="whenRequired"'));
  assert.ok(strict.includes('response_checksum_validation="whenRequired"'));
});

test("records the bucket and prefix as comments", () => {
  const snippet = boto3Snippet(base);
  assert.ok(snippet.includes("# bucket: my-bucket"));
  assert.ok(snippet.includes("# prefix: some/path/"));
});

test("only emits a session token when there is one", () => {
  assert.ok(!boto3Snippet(base).includes("aws_session_token"));
  assert.ok(
    boto3Snippet({ ...base, sessionToken: "tok" }).includes('aws_session_token="tok"'),
  );
});

test("payload signing is reflected", () => {
  assert.ok(boto3Snippet({ ...base, payloadSigning: true }).includes('"payload_signing_enabled": True'));
});

test("a missing secret is not invented", () => {
  const snippet = boto3Snippet({ ...base, secretAccessKey: "" });
  assert.ok(snippet.includes("stored on this machine"));
  assert.ok(!snippet.includes('aws_secret_access_key=""'));
});

test("the snippet only carries the values it was given", () => {
  const snippet = boto3Snippet(base);
  // Every endpoint, bucket and key in the output must come from the arguments:
  // the generator must not embed a default deployment of its own.
  const urls = snippet.match(/https?:\/\/[^"\s]+/g) ?? [];
  assert.deepEqual(urls, ["https://s3.example.com"]);
  assert.equal(snippet.match(/bucket:/g)?.length, 1);
});
