# Security

Report vulnerabilities privately: **Security › Report a vulnerability** on this repository, not in a public issue. You'll
get an answer within a week. Only the latest release gets fixes.

- Run it behind HTTPS and don't expose port 8080. Wrong passwords, unknown keys and new saves are rate-limited per IP
  (from `X-Forwarded-For`; set `LISTICK_TRUSTED_PROXIES` behind more than one proxy).
- An install link gives access to your lists: a saved one names a UUID, an unsaved one contains your API key. Don't share
  it; replace the key in Listick if it leaks.
- Saved settings include the API key: protect the `/data` volume and its backups.
