# Security Policy

Nocta runs programs you give it. The playground runs them inside your browser tab and sends nothing to a server.
The CLI reads the files you name and the modules they import. Nocta programs have no file, network or process access
of their own.

## Reporting

Please report security problems privately through
[GitHub private vulnerability reporting](https://github.com/jullewz/nocta/security/advisories/new).

Relevant issues include:

- a Nocta program that escapes the VM, for example by reaching JavaScript globals or prototypes
- script injection in the playground through code, diagnostics, output or a share link
- the development server serving files outside the project folder
- a program that hangs the host despite the step limit, or crashes it with an uncaught JavaScript error

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Embedding safely

When you run untrusted Nocta code in your own application, set `maxSteps` and keep the default `maxFrames`. Run it
in a worker if a long computation must not block your main thread. Only pass a `loadModule` callback that reads the
files you intend to expose.
