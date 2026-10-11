# Short-link service

A small HTTP API that creates short codes, redirects visitors, and counts follows. It uses Node.js and persistent SQLite, with no third-party dependencies.

## Run locally

Install Node.js 22.13 or newer (Node.js 24 LTS is suitable), then:

```sh
npm start
```

The service listens at `http://localhost:3000`. `PORT` overrides the port; `DB_PATH` overrides the default `./data/links.db` file. The database directory is created automatically. Run the HTTP integration tests with `npm test`.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/links` | Create or retrieve a link from a JSON body containing `url` |
| GET | `/:code` | Return a `302` redirect and increment the follow count |
| GET | `/links/:code/stats` | Return `code`, `url`, `visits`, and `createdAt` |
| GET | `/health` | Return `200` with `{ "ok": true }` |

```sh
curl -i http://localhost:3000/links \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

First creation returns `201`; an existing URL returns `200`. Both return the same JSON body, for example:

```json
{"code":"AbC123xy","url":"https://example.com/","path":"/AbC123xy"}
```

Use the returned path to follow the link, or the code to read statistics:

```sh
curl -i http://localhost:3000/AbC123xy
curl http://localhost:3000/links/AbC123xy/stats
```

The example code is illustrative: use the code returned by your create request.

## Validation and errors

Validation happens before database insertion. `url` must be a nonempty string of at most 2048 characters, starting with `http://` or `https://`, and parse as an absolute URL with a hostname. Credentials, whitespace, backslashes, and other schemes are rejected. Syntactic validation does not guarantee the target is reachable. The server redirects to targets; it does not fetch them.

Malformed JSON, an invalid body shape, a missing URL, an invalid URL, and bodies larger than 16 KiB return `400` with a field-specific message:

```json
{"error":"validation","fields":{"url":"url is required and must be a string"}}
```

Malformed JSON reports the `body` field. Unknown codes and routes return `404` with `error: "not_found"`. Unexpected server failures return `500` with `error: "internal"` and a diagnostic ID; exception messages are not exposed.

## Data model and retry safety

The `links` table contains `code` (primary key), `url` (unique, required), `visits` (integer, initially zero), and `createdAt` (UTC timestamp).

The URL is normalized using the built-in URL parser before lookup and storage. For example, `https://example.com` and `https://example.com/` share a code. Query parameters and fragments are retained; URLs differing in these may be distinct.

The normalized URL is the create operation's idempotency identity. The database UNIQUE constraint prevents two concurrent requests from storing different codes for the same URL. `INSERT OR IGNORE` followed by reading the URL returns the winning record. A random code collision generates another candidate. A crash after insertion but before responding is safe: the retry retrieves the persisted record. The response excludes mutable visit counts so its body stays identical on retries. This guarantee requires the same persistent SQLite database; independent database copies cannot coordinate.

Following a link increments its counter using a single atomic database update, preventing lost increments. Counts represent successful redirect requests, not unique people: bots and repeated follows each count.

## Why 302 instead of 301?

This service deliberately uses `302 Found` with `Cache-Control: no-store`. A cached permanent `301` could let browsers bypass the service on later visits, preventing those visits from being counted and making a later redirect-policy change difficult. Every follow should reach this service to update statistics. A redirect is temporary even though this implementation currently has no target-edit endpoint.

## Deployment

Run `npm start` on a host supporting Node.js and a persistent writable disk. Set `DB_PATH` to a file on that disk, and use one service instance with that database. Put HTTPS in front of the service. Ephemeral disks lose links on restart or redeployment; multiple instances with separate databases do not share codes or counts.

Publish this directory to a repository you own. Never commit `.env`, database files, or credentials. Set runtime configuration through the hosting provider. Verify the public `/health`, invalid create requests, unknown codes, and repeated creates before submitting the repository or service link requested by the platform.

This focused brief does not include authentication, accounts, or a growing list endpoint. Those would be additional work if submitting this service for the broader final-project requirements.

## Verification

`npm test` checks malformed input, missing codes, concurrent duplicate creates, stable retry responses after follows, redirect status and headers, concurrent visit counts, and persisted data after a restart. Tests use isolated temporary databases.

The linked course lesson could not be retrieved during implementation. This service was built against the supplied brief; the lesson still needs to be read in your signed-in course session.
