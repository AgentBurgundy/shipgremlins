# Reproducible browser upload fixtures

The `fixture` command creates real CSV and PNG files for testing web applications. It runs locally without credentials, network access, or additional dependencies. It never overwrites an existing file. Each successful command prints a JSON manifest with the absolute path, media type, byte count, and SHA-256 hash; it does not print the file's contents.

Paths resolve against `SHIPGREMLINS_HOME` when set, otherwise the installation directory. Absolute paths are accepted. Use a unique directory for each run, such as `.run/fixtures/run-123/`.

## CSV imports

Create a trusted JSON input containing an array of objects:

```json
[
  { "name": "Ana", "note": "Contains a comma, and \"quotes\"", "active": true },
  { "name": "李", "note": "Two\nlines", "active": false }
]
```

```sh
gremlins fixture csv --input /absolute/path/rows.json --output .run/fixtures/run-123/import.csv
```

Object keys produce a header row in first-seen order. Missing keys and null values produce empty fields. Arrays of arrays are also accepted; include a header as the first array when the target application requires one. Array rows must have equal lengths. Values must be strings, finite numbers, booleans, or null. Nested objects and arrays are rejected.

The encoder preserves Unicode and uses RFC 4180 quoting: commas, double quotes, and embedded newlines are quoted; quotes are doubled; records end in CRLF. `--bom` adds a UTF-8 BOM for importers that require it.

Inputs are limited to 4 MiB, 10,000 rows, and 256 columns; generated CSVs are limited to 16 MiB. Use trusted synthetic input. Formula-like strings are deliberately preserved without adding apostrophes or otherwise changing test values. Opening these fixtures in a spreadsheet may evaluate formulas; test an application's handling intentionally rather than using real customer input.

## PNG uploads

```sh
gremlins fixture png --output .run/fixtures/run-123/avatar.png --width 640 --height 480 --seed 1
```

This produces a valid RGB PNG with a deterministic colored grid. The same dimensions and seed produce the same bytes; change the seed to create a different fixture. Dimensions must be integers from 1 to 2048 inclusive. The seed must be an integer from 0 to 4294967295. Defaults are 640 × 480 and seed 1.

The file has a standard PNG signature, IHDR, compressed IDAT pixel data, IEND, and CRC checksums. This is a synthetic upload image, not AI artwork or a browser screenshot. Never use a generated fixture as verification screenshot evidence.

## Exercise the application

1. Sign into an isolated test account using your project's approved browser recipe.
2. Open the application's actual upload control in Playwright MCP and supply the generated absolute path through its file chooser/upload tool.
3. Assert the expected imported rows, image preview, dimensions, validation message, or processing result. Capture real browser screenshots of the result and include the assertions in verification evidence.
4. Remove only records and files created by this test run. Preserve any artifacts referenced by evidence according to your retention policy.

Creating a file does not prove the upload flow works. Invalid-file tests can be constructed deliberately in the isolated test workspace, but the fixture command itself emits structurally valid files. PDF/office fixtures, semantic AI image generation, and provider-neutral image tools remain separate roadmap work.
