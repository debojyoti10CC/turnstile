# @turnstile/dashboard

Read-only React/Vite dashboard that polls `apps/demo-merchant`'s debug endpoints: open channels
(deposit, charged, signed max, claimed, exposure, withdraw countdown), the real `pnpm bench` results
(`apps/demo-agent/bench.json`), and the real `pnpm adversary` report
(`packages/adversary/report.json`). Every number on the page is either live server state or a file
one of this repo's own CLIs wrote — nothing here is synthesized for display.

```bash
pnpm -F @turnstile/demo-merchant start   # must be running first (serves /debug/*)
pnpm -F @turnstile/dashboard dev         # http://localhost:5173
```

Point it at a non-default merchant with `VITE_MERCHANT_URL=http://host:port pnpm -F @turnstile/dashboard dev`.
