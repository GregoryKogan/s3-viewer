import test from "node:test";
import assert from "node:assert/strict";
import { boto3Snippet } from "../../src/js/connection-form.js";

const base = {
  endpointUrl: "https://obs.example.ru",
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "SECRET",
  bucket: "my-bucket",
  prefix: "some/path/",
  signatureVersion: "s3v4",
  addressingStyle: "virtual",
  payloadSigning: false,
};

test("uses the exact boto3 argument names", () => {
  const snippet = boto3Snippet(base);
  assert.match(snippet, /import boto3/);
  assert.match(snippet, /from botocore\.config import Config/);
  assert.match(snippet, /boto3\.client\(/);
  assert.ok(snippet.includes('endpoint_url="https://obs.example.ru"'));
  assert.ok(snippet.includes('region_name="us-east-1"'));
  assert.ok(snippet.includes('aws_access_key_id="AKIAEXAMPLE"'));
  assert.ok(snippet.includes('aws_secret_access_key="SECRET"'));
  assert.ok(snippet.includes('signature_version="s3v4"'));
  assert.ok(snippet.includes('"addressing_style": "virtual"'));
  assert.ok(snippet.includes('"payload_signing_enabled": False'));
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
