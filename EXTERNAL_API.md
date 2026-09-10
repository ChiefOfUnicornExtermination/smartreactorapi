# External Website API

Base URL:

```text
https://api.unicornextermination.info
```

This API can be called by a trusted external website. It is not an OAuth
provider: the external website sends the user's Penlight Waver email and
password to `/auth/login`, then uses the returned JWT. Do not use this flow
with an untrusted third-party website, and never expose the JWT in URLs,
browser logs, or client-side analytics.

All requests and responses use JSON. Send:

```http
Content-Type: application/json
```

## 1. Log In

```http
POST /auth/login
```

Request:

```json
{
  "email": "user@example.com",
  "password": "user-password"
}
```

Success response (`200`):

```json
{
  "message": "Login successful",
  "token": "eyJ...",
  "user_id": 123,
  "email": "user@example.com"
}
```

Invalid credentials return `401`:

```json
{
  "error": "Invalid email or password"
}
```

The JWT expires after seven days. Include it in all user/device requests:

```http
Authorization: Bearer eyJ...
```

## 2. Verify the Login Token

```http
POST /auth/verify
Authorization: Bearer <token>
```

Success response (`200`):

```json
{
  "message": "Token is valid",
  "user_id": 123,
  "email": "user@example.com"
}
```

An absent, invalid, or expired token returns `401`.

## 3. List the User's Devices

```http
GET /devices/mine
Authorization: Bearer <token>
```

Success response (`200`):

```json
{
  "devices": [
    {
      "id": "device-AA:BB:CC:DD:EE:FF",
      "name": "My Penlight Waver",
      "type": "penlightwaver",
      "created_at": "2026-09-01T12:34:56.000Z",
      "online": true,
      "light": "off",
      "motor": "stopped",
      "rgb": "purple",
      "last_seen": "2026-09-09T12:34:56.000Z"
    }
  ]
}
```

`online`, `light`, `motor`, `rgb`, and `last_seen` are the most recently
reported device state. They can be `false`, `unknown`, `off`, or `null` before
the device first connects.

## 4. Read One Device's State

```http
GET /devices/{deviceId}/status
Authorization: Bearer <token>
```

Success response (`200`):

```json
{
  "device_id": "device-AA:BB:CC:DD:EE:FF",
  "device_name": "My Penlight Waver",
  "online": true,
  "light": "off",
  "motor": "stopped",
  "rgb": "purple",
  "last_seen": "2026-09-09T12:34:56.000Z"
}
```

If the device does not belong to the logged-in user, the API returns `404`:

```json
{
  "error": "Device not found or not yours"
}
```

## 5. Start a Timed Wave

```http
POST /devices/{deviceId}/wave
Authorization: Bearer <token>
```

Request:

```json
{
  "color": "purple",
  "brightness": 200,
  "motorSpeed": 80,
  "durationSeconds": 10
}
```

All fields are optional. Defaults are `white`, `200`, `100`, and `0`.
`durationSeconds: 0` means run until another command or a stop request.

| Field | Valid values |
|---|---|
| `color` | `red`, `green`, `blue`, `white`, `yellow`, `cyan`, `purple` |
| `brightness` | Integer from `0` to `255` |
| `motorSpeed` | Integer from `1` to `100` |
| `durationSeconds` | Integer from `0` to `3600` |

Success response (`200`):

```json
{
  "status": "ok",
  "device_id": "device-AA:BB:CC:DD:EE:FF",
  "color": "purple",
  "brightness": 200,
  "motorSpeed": 80,
  "durationSeconds": 10,
  "timed": true
}
```

The ESP32 enforces the timeout locally and turns both the motor and RGB LED
off when it expires.

Stop a wave immediately:

```http
POST /devices/{deviceId}/wave/stop
Authorization: Bearer <token>
```

Success response (`200`):

```json
{
  "status": "ok",
  "device_id": "device-AA:BB:CC:DD:EE:FF",
  "motor": "stopped",
  "rgb": "off"
}
```

## 6. Individual Controls

All individual controls require the same bearer token and device ownership.

| Method | Endpoint | Request body | Success field |
|---|---|---|---|
| `POST` | `/devices/{deviceId}/light/on` | None | `light: "on"` |
| `POST` | `/devices/{deviceId}/light/off` | None | `light: "off"` |
| `POST` | `/devices/{deviceId}/motor/run` | None | `motor: "running"` |
| `POST` | `/devices/{deviceId}/motor/stop` | None | `motor: "stopped"` |
| `POST` | `/devices/{deviceId}/rgb` | `{"color":"red"}` | `rgb: "red"` |

Each successful individual command has this general shape:

```json
{
  "status": "ok",
  "device_id": "device-AA:BB:CC:DD:EE:FF",
  "light": "on"
}
```

## 7. Public Product Catalog

No token is needed for catalog requests.

```http
GET /catalog/penlightwaver?lang=ja
```

Supported language codes are `en`, `ja`, `es`, `fr`, `de`, `zh-TW`, and `ko`.
Unsupported codes fall back to English. `GET /catalog?lang=ja` returns the
full product list in the same localized format.
