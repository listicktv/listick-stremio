# listick-stremio

Your [Listick](https://github.com/listicktv/listick) lists as Stremio catalogs: Plan to watch, Up next, your own and smart
lists, For you and Listick's rows. Choose which show, rename and reorder them, and put each on Home or in Discover. In
Stremio the addon is called **Catalogs**.

## Requirements

- Docker with Compose v2 (images for `linux/amd64` and `linux/arm64`)
- A Listick API key for this addon: in Listick, **Settings › API access › Stremio addon**
- A free [TMDB API Read Access Token](https://www.themoviedb.org/settings/api) for title details and search (optional:
  a TheTVDB API key)

## Install

1. Download [`compose.yaml`](compose.yaml) and [`.env.example`](.env.example) into an empty folder.
2. `cp .env.example .env` and set `LISTICK_URL` and `TMDB_ACCESS_TOKEN`.
3. `docker compose up -d`
4. Open http://localhost:8080, paste your Listick API key, pick your catalogs and click **Install in Stremio**.

**Save** the settings with a password to change them later; you get a UUID to sign in with.

## On the internet

For other devices (TV, phone, Stremio Web), put it behind a reverse proxy with HTTPS and install it from that address.
Behind more than one proxy, set `LISTICK_TRUSTED_PROXIES` (for example `2`).

## Update and back up

```bash
docker compose pull && docker compose up -d
docker compose cp listick-stremio:/data/listick-stremio.db ./backup.db
```

## More

[Releases](https://github.com/listicktv/listick-stremio/releases) · [Credits](CREDITS.md) · [Security](SECURITY.md)

## Support

- ⭐ Star this repository
- 🐞 Report bugs or suggest features in [issues](https://github.com/listicktv/listick-stremio/issues)
- 🤝 Pull requests are welcome (`npm test`; no dependencies)
- ☕ Donate on [Ko-fi](https://ko-fi.com/listicktv)

## Disclaimer

listick-stremio shows your Listick lists and title details in Stremio. It does not host, stream or link to any video.
Titles, images and episode lists come from third-party services and belong to their owners. You are responsible for using
it within their terms and the law. Not affiliated with Stremio.

Licence: [AGPL-3.0](LICENSE).
