# Files Finn JS workspace Toolset

Human reference only. Runtime model instructions are generated from the typed manifest after process and grant filtering.

The Files toolset describes Finn API access to scoped file surfaces:

- Stored Library files.
- Workspace files.
- Temporary tool-output artifacts.

Runtime adapters outside `@finn/toolsets` execute the APIs and enforce workspace, storage, sandbox, and visibility policy. This package owns command names, schemas, effects, process availability, and generated Finn JS workspace metadata.
