# Atlas releases and provenance

## Version control history

Atlas had no repository until 2026-11-09. Versions 0.1.0 and 0.2.0 were never committed, and no source for them is
tagged here. The history starts at 0.3.0. Nothing was backdated or reconstructed.

## 0.4.0

| | |
| --- | --- |
| Tag | `v0.4.0` (annotated, tag object `c466f62ce5f834a16e3cdbd8904d280920a7ac64`) |
| Release commit | `bd739d42631e81446f0d5ac880a1f9218b67f991`, created 2026-11-09 before any deployment |
| Release image | `sha256:2966105a515ab0e181f76ff640ea5f79bc66e4301aa38faeee464cf7def41f70`, built from a clean clone of this commit |
| Image built | 2026-11-09T18:15:02.347253045Z |
| Deployed | **Not deployed to Exodus.** This image runs on aetest |
| CI | This repository has no GitHub Actions workflow. The equivalent checks ran locally from a clean clone |

### What has been demonstrated

Checked on 2026-11-09. Evidence is in `VALIDATION_P1_NAVIGATION_AETEST_2026-11-09.md` at the workspace root.

- All 20 files under the image's `/app/backend` and `/app/frontend` are byte-identical to this commit.
- Against the working-tree build first validated on aetest, those files match except for line endings: 20 byte-identical and 0 differing only in line endings.
- This exact image was then installed on aetest, and the universal navigation journeys passed against it in Chromium, WebKit and Firefox on Linux.
- The unit suite passes on the clean clone: 77 passed.

### What has not been demonstrated

- The build is **not reproducible to the digest**. Rebuilds of unchanged source gave different image IDs.
- Physical mouse buttons, native keyboard shortcuts, Safari and real phones have not been checked.
- It has not run in production.

## 0.3.0

| | |
| --- | --- |
| Tag | `v0.3.0` (annotated, tag object `5b751d04bc291a1e17b3c5a01bdbb0ca5ae665d5`) |
| Baseline commit | `b4cd26cb8fb83b061bf4e061c6f85e797a315d88`, created after deployment |
| Schema | 3 |
| Deployed image | `sha256:9549ed6a81381bc7454da9522b4890083e9d932143b37d2a0e6ef2ff41040cac` |
| Image platform manifest | `sha256:bac5669b5bbbeec341ad9a9af661f36c9e1d5ee0791bc7bd5bbc397a52cdedf6` (linux/amd64) |
| Image config | `sha256:7ad3e943962aec1b274eaa57dd18b1a34689baa4df7d1bb286aa6452b0b86d15` |
| Image built | 2026-11-09T09:58:22Z |
| Deployed | Exodus, 2026-11-09. The running container's image was read back on 2026-11-09 and matches the digest above |

### What has been demonstrated

Checked on 2026-11-09 from a fresh clone of `v0.3.0` from GitHub, against the image archive saved at release time
(`deployment/2026-11-09-atlas-meridian/atlas-0.3.0.tar` in the workspace, whose index digest is the deployed digest).

- All 20 versioned files in the image's `/app` (`backend/`, `frontend/`, `LICENSE`, `requirements.lock`) are byte-identical to the tag.
- A rebuild of the tag with `deploy/Dockerfile` succeeded. All 5,735 files in the rebuilt image are byte-identical to the deployed image, across the whole filesystem. Entrypoint, environment, user and Python version (3.13.18) are the same.
- `manifest.json` is identical to the deployed manifest except for the image digest, which it leaves zeroed by design.
- The unit suite passes on the clone: 77 passed.

### What has not been demonstrated

The build is **not reproducible to the digest**. The rebuild produced `sha256:e80b80ad20bcbdeffeebf8bbb551c2e9cdc9d725fcfc94d7238f0b2abcd1a67d`, and 7 of 11 layers are shared.

- The deployed image holds 8 extra files, `backend/atlas/__pycache__/*.cpython-313.pyc`. The image was built from a working tree, and `.dockerignore` does not exclude `__pycache__`, so they were copied in from local test runs. A clean checkout has none. They are the only file differences.
- Layer timestamps also differ between builds, so the digests would differ even without those files.
- The commit was made after the image was built. It records matching content, not the build's actual input.
- The unit tests read a stylesheet from a sibling Meridian checkout, and that checkout's state is not pinned by this repository.

### Differences from the release-time source snapshot

`source-snapshot.tar.gz`, taken at 11:15 local time on deployment day, differs from the tag only outside the runtime:

- `README.md`, whose status line was updated afterwards.
- 15 screenshots under `docs/screenshots/`, modified between 11:17 and 11:20 after the snapshot was taken.
- `manifest.local.json`, which is ignored by design. It held the digest recorded above.

## Conventions

Build releases from a clean checkout of the tag, and create the tag before deploying. Record the commit and the image digest
in the deployment record. Do not rewrite a published tag.
