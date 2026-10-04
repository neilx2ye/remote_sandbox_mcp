# Upload conversation files to the current project

`fs_upload` adds binary-safe file transfer. It preserves original bytes; it does not convert an image into text/base64 or recompress it.

## Activation

1. Run `npm run build` and restart the existing RS server using its normal launcher and configuration.
2. Refresh/scan tools on the existing ChatGPT RS connection. Reuse the existing connection; do not create an unauthenticated replacement.
3. Confirm `fs_upload` is listed. `sys_info` should report `fileUploadEnabled: true` and `fileUploadTool: "fs_upload"` in a writable project.
4. Select the intended destination project before uploading. A connection pointed at the RS source project writes there, not to a different image project.

## Arguments

- `file`: a host-provided conversation file reference. The ChatGPT runtime supplies `download_url`, `file_id`, and optionally `mime_type` and `file_name`.
- `path`: destination relative to the current project, e.g. `assets/cinematic_rgb_gaming_workspace.png`.
- `createDirs`: create missing parents, default false.
- `overwrite`: explicitly replace an existing file, default false.
- `expectedSha256`: optional SHA-256 of original bytes.

The tool descriptor declares `_meta["openai/fileParams"] = ["file"]`. The file schema declares all four supported properties and requires only `download_url` and `file_id`, per the OpenAI file-input contract. Callers in ChatGPT pass the local file reference; they must not invent a download URL or put file contents in a text argument.

Success returns `{ path, bytes, sha256, mimeType }` as both text and structured content. An error does not count as a successful upload. Download URLs are short-lived: retry with the file reference rather than copying an expired URL.

## Protections

- Only current-project relative destinations; sandbox symlink/junction checks apply.
- Read-only projects do not expose the tool.
- Enforces the project's existing `maxFileBytes` setting; no limit increase is made.
- HTTPS/443 only; rejects credentials and private/special IP destinations, including redirects. DNS results are checked and the chosen address pinned for the connection.
- Bounded download time, redirect count and byte size.
- SHA-256 verification before publication; temporary-file cleanup and atomic non-overwrite publication.
- No signed URLs in upload receipts or audit targets.

Keep authentication enabled at the server or a trusted gateway for public deployments. This patch does not change existing auth, tokens, project roots, permissions, or tunnel settings.

## Verification

`npm test` covers original functionality, metadata discovery through MCP, binary byte preservation, overwrite behavior, size and digest checks, read-only scope, traversal/junction rejection, concurrent non-overwrite writes, and download URL/IP validation. Unit tests use a synthetic binary fixture and a mocked download response, not the user's actual image or live ChatGPT storage.

A real conversation-to-project transfer still needs to be verified after server restart and tool refresh. Compare the returned SHA-256 with the original image. For `cinematic_rgb_gaming_workspace.png` in this repair session, the source was 2,008,560 bytes, SHA-256 `d624f3a5e1ec0e314a345bc924ed3ded7dd2902a6647dd278563b8af54f53d3a`.

Reference: https://developers.openai.com/plugins/reference#define-file-inputs
