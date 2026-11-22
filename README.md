# AnswerWall

AnswerWall sends one prompt to several AI models at once and shows their
answers side by side as they stream in. It is a question-and-answer comparison
tool for a single user, driving the official command-line tools you have
installed yourself and any OpenAI-compatible endpoints you configure.

**Under construction.** Nothing here is usable yet. See
[docs/DECISIONS.md](docs/DECISIONS.md) for the engineering decisions and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map.

## Development

Requires Node 24 and pnpm 12.

```
pnpm install
pnpm dev         # core server and web dev server
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## License

[MIT](LICENSE)
