# Third-Party Notices

SubBoost uses open-source dependencies and external data sources. This file is a
human-readable summary, not a full dependency license inventory.

## npm Dependencies

The app depends on packages from the npm ecosystem, including Next.js, React,
Prisma, Radix UI, lucide-react, js-yaml, Peggy, Tailwind CSS, Zustand, and
related build/test tools. Their individual licenses are recorded in
`package-lock.json` and distributed with the package registry metadata.

## UI Components

Some shared UI primitives follow common shadcn/ui-style composition patterns and
wrap Radix UI primitives. shadcn/ui is MIT licensed, and Radix UI primitives are
MIT licensed.

lucide-react icons are provided by the Lucide project.

## Proxy and Rule Ecosystem

SubBoost generates and parses Clash/Mihomo-compatible configuration data and
links to external ecosystem resources.

- Mihomo core: https://github.com/MetaCubeX/mihomo
- MetaCubeX rule data: https://github.com/MetaCubeX/meta-rules-dat

The public source includes rule catalog identifiers and URLs for discovery and
configuration. It does not vendor the complete upstream rule dataset.

## Mihomo Kernel Binary (Health Checks)

Production images vendor the official mihomo binary at a pinned version
(`metacubex/mihomo:v1.19.28`) so that subscription health checks can run inside
the container without extra setup. Mihomo is licensed under GPL-3.0-only; its
source is available at https://github.com/MetaCubeX/mihomo. You can replace or
disable the bundled binary by setting the `MIHOMO_PATH` environment variable
(for example, point it at a self-built binary), and self-hosted builds that do
not use the official image can provide the binary on `PATH` instead.

## Compatibility Research

Parser compatibility fixtures and notes may reference external open-source
projects for behavior comparison. When importing compatibility knowledge, keep
source attribution, commit/license notes, and avoid vendoring third-party raw
fixture files wholesale.
