# PocketChest API

The `/api/*` routes of the PocketChest Worker. The frontend calls them on the same origin; the API sends no CORS headers.

## Architecture

- **Cloudflare Workers**: Edge computing for API endpoints
- **R2 Storage**: Files, text content and per-chest JSON manifests (no database)
- **JWT Authentication**: Token-based security for uploads and downloads
- **TOTP Authentication**: Optional two-factor authentication for enhanced security

## API Endpoints

### 1. Get Configuration
```
GET /api/config
```
Returns server configuration including TOTP requirements.

**Response:**
```json
{
  "requireTOTP": true
}
```

### 2. Create Chest
```
POST /api/chest
```
Creates a new upload session and returns an upload token.

**Body (when TOTP is enabled):**
```json
{
  "totpToken": "123456"
}
```

**Response:**
```json
{
  "sessionId": "uuid-v4",
  "uploadToken": "jwt-token",
  "expiresIn": 86400
}
```

### 3. Upload Files
```
POST /api/chest/:sessionId/upload
Authorization: Bearer {uploadToken}
Content-Type: multipart/form-data
```

**Body:**
- `files`: File objects
- `textItems`: JSON strings with `{content, filename?}` format

**Response:**
```json
{
  "uploadedFiles": [
    {
      "fileId": "uuid",
      "filename": "example.txt",
      "isText": false
    }
  ]
}
```

### 4. Multipart Upload (Large Files)

#### 4a. Create Multipart Upload
```
POST /api/chest/:sessionId/multipart/create
Authorization: Bearer {uploadToken}
Content-Type: application/json
```

**Body:**
```json
{
  "filename": "large-file.zip",
  "mimeType": "application/zip",
  "fileSize": 104857600
}
```

**Response:**
```json
{
  "fileId": "uuid",
  "uploadId": "multipart-upload-id",
  "multipartToken": "jwt-token"
}
```

#### 4b. Upload Part
```
PUT /api/chest/:sessionId/multipart/:fileId/part/:partNumber
Authorization: Bearer {multipartToken}
Content-Type: application/octet-stream
```

**Response:**
```json
{
  "etag": "part-etag",
  "partNumber": 1
}
```

#### 4c. Complete Multipart Upload
```
POST /api/chest/:sessionId/multipart/:fileId/complete
Authorization: Bearer {multipartToken}
Content-Type: application/json
```

**Body:**
```json
{
  "parts": [
    {
      "partNumber": 1,
      "etag": "part-etag"
    }
  ]
}
```

**Response:**
```json
{
  "fileId": "uuid"
}
```

### 5. Complete Upload
```
POST /api/chest/:sessionId/complete
Authorization: Bearer {uploadToken}
Content-Type: application/json
```

**Body:**
```json
{
  "fileIds": ["uuid1", "uuid2"],
  "validityDays": 7
}
```

`validityDays` must be one of `1`, `3`, `7`, `15` or `-1` (permanent).

**Response:**
```json
{
  "retrievalCode": "A1B2C3",
  "expiryDate": "2024-01-01T00:00:00Z"
}
```

### 6. Retrieve Chest Contents
```
GET /api/retrieve/:retrievalCode
```

**Response:**
```json
{
  "files": [
    {
      "fileId": "uuid",
      "filename": "example.txt",
      "size": 1024,
      "mimeType": "text/plain",
      "isText": false,
      "fileExtension": "txt"
    }
  ],
  "chestToken": "jwt-token",
  "expiryDate": "2024-01-01T00:00:00Z"
}
```

### 7. Download File
```
GET /api/download/:fileId
Authorization: Bearer {chestToken}
```

Returns the file content with appropriate headers.

The token can also be passed as `?token={chestToken}` (used for direct browser downloads). An optional `?filename=` overrides the download name; it is sanitized and sent as an RFC 6266 `Content-Disposition` header.

Setup, configuration and deployment are covered in the [README](../README.md) and [DEPLOYMENT.md](../DEPLOYMENT.md).

## Errors

Error responses are JSON with a human-readable message and a stable code:

```json
{ "error": "Retrieval code not found or expired", "code": "CHEST_NOT_FOUND" }
```

Codes: `NOT_FOUND`, `INVALID_REQUEST`, `INVALID_CODE`, `INVALID_SESSION`, `AUTH_REQUIRED`, `AUTH_INVALID`, `TOKEN_MISMATCH`, `TOTP_REQUIRED`, `TOTP_INVALID`, `TOTP_NOT_CONFIGURED`, `SESSION_NOT_FOUND`, `FILE_NOT_IN_SESSION`, `FILE_NOT_FOUND`, `CHEST_NOT_FOUND`, `CODE_GENERATION_FAILED`, `INTERNAL_ERROR`.

## Security Features

- JWT-based authentication for uploads and downloads
- Session-based access control
- File ownership validation
- Expiry-based cleanup
- Same-origin only (no CORS headers)
- Retrieval codes generated with `crypto.getRandomValues`
- Optional TOTP two-factor authentication
- Multipart upload support for large files (with separate JWT tokens)

## Storage

All state lives in R2 (see the storage layout in [DEPLOYMENT.md](../DEPLOYMENT.md#storage-layout)). File content is stored at `{sessionId}/{fileId}`; completing an upload writes a JSON manifest at `codes/{CODE}`, which `/api/retrieve` and `/api/download` read. Text content is stored as plain text files, and the frontend can differentiate using the `isText` flag.

## Multipart Upload Flow

For large files (typically >100MB), use the multipart upload flow:

1. Create multipart upload session
2. Upload file in parts (5MB - 5GB per part)
3. Complete multipart upload with part ETags
4. File is automatically added to the session

This approach provides better reliability for large file uploads and allows for upload resumption.