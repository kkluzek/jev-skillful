# Fork workflow

This fork is installed globally from the source checkout, so rebuilding updates both Claude Code
and Codex without publishing an npm package.

## Vercel AI Gateway

Skillful supports the same three Jev routes as the local `typesafe-mcp` fork: direct TypeSafe,
Vercel AI Gateway, and OpenRouter. Vercel uses:

- endpoint: `https://ai-gateway.vercel.sh/typesafe/v1/systemone`
- model: `typesafe-ai/jev`
- credential: `AI_GATEWAY_API_KEY`
- explicit selector: `SKILLFUL_PROVIDER=vercel`

On macOS, install the source-linked Keychain launcher:

```sh
scripts/install-skillful-vercel-macos
```

Its default Keychain service/account match the `typesafe-mcp` fork. If the dedicated key has not
already been stored, run this interactively first:

```sh
scripts/store-skillful-vercel-key-macos
```

The store helper and installer trust only Apple's signed `/usr/bin/security` accessor for the
shared generic-password item. This avoids repeated approval dialogs in new sessions and subagents
without using the insecure allow-any-application ACL. The launcher reads from the unlocked login
Keychain and never writes the key to Claude/Codex configuration. It sets
`SKILLFUL_HOOK_LAUNCHER` while installing, so every hook records the launcher's absolute path. For
decision commands the launcher reads the key, unsets unrelated provider keys, forces Vercel, and
replaces itself with the globally linked `skillful` process.

The launcher does not automate the Passwords app or export a website-password record. If the key
exists only there, paste it once into the store helper; both repositories then reuse the shared
generic-password item without another prompt.

## Rebuild and verify

```sh
pnpm install --frozen-lockfile
pnpm --filter @mrgoonie/skillful typecheck
pnpm --filter @mrgoonie/skillful test
pnpm --filter @mrgoonie/skillful build
scripts/install-skillful-vercel-macos
skillful-vercel doctor
```
