# Security policy

## Supported versions

Only the latest published version receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/aleradev12/pi-model-picker/security/advisories/new)
and include reproduction steps, affected versions, and the expected impact.

You should receive an acknowledgement within 72 hours. A fix and disclosure
timeline will be coordinated after the report is reproduced.

## Scope

Pi Model Picker is a local TUI extension. It does not make network requests or
execute external commands. It reads model metadata exposed by Pi and stores its
preferences under Pi's agent directory. Setting a default model updates only
the `defaultProvider` and `defaultModel` fields in Pi's `settings.json`.
