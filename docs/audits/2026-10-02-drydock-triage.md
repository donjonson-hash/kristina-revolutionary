# Drydock audit d2c2e5ef: source review and follow-up

Reviewed on 2026-10-02. This is a triage record, not a new scanner run or a
certificate of release security.

## Scope mismatch

The supplied archive is named `donjonson-hash-kristina-revolutionary-44acc77`
and contains 276 files. Reviewed anchors match repository commit
`44acc778265e007f7680056e4d6758620b7894ea`. Drydock did not record a Git commit
in its own provenance; the archive name alone is not cryptographic proof.
Recorded archive SHA-256:
`0ca8a2ccba2adba5d8be4540dbf6198fc10c1a6d9eec99d478501138d0d4822a`.

That revision packages the historical 0.18.1 extension. CTT 0.33.6 was saved
separately in the Site source repository. The consolidation imports it into
`ctt/src/` and records its origin and published ZIP checksums in
`ctt/provenance.json`. A new repository scan is required after consolidation
is merged; existing findings do not cover the newly imported release.

## Triage of current-scan observations

| Observation IDs | Review result |
| --- | --- |
| 7, 8, 9, 19, 20, 21 | Three duplicated SQL locations. Table identifiers come from fixed literal lists; no untrusted identifier flow was found at these anchors. A hypothetical future code change is not a current SQL injection. |
| 2–5 | Scout DOM insertion uses escaped text, checked HTTP(S) URLs and fixed tag labels. XSS was not established by these anchors. Scout is separate from CTT. |
| 10 | The claim that unconfigured CORS allows all origins is contradicted by the guard, and by the model's own explanation. Requests carrying a foreign Origin are rejected. Local non-browser clients are a separate trust-boundary question. |
| 11, 23 | No Origin bypass reproduced. Five isolated checks of the actual local Python guard passed, including mismatched-port rejection and valid IPv6 localhost. Different effective ports are different origins. |
| 29–31 | CTT test `token` fields are synthetic IndexedDB revision identifiers, not authentication credentials. |
| 1, 32–35 | Documentation/example and test fixture contexts. Do not treat them as confirmed live credentials or request rotation without evidence of real reuse. |
| 22 | Scout writes a temporary credential file with mode 0600 inside a 0700 directory, then removes it in finally. Residual files after abrupt process death remain a hardening topic; world-readable exposure was not established. |
| 13–18, 24–28 | Several duplicate cost/performance observations concern Kristina's AI clients, not offline CTT. Daily-learning deduplication and session reuse merit separate changes. A failed provider call is not proof of a second charge. |
| 12 | Optional automatic channel publication is a product moderation decision for Kristina. It is not a CTT document-processing vulnerability. |
| 6 | Absence of Docker is deployment inventory, not a defect by itself. |

No high-impact vulnerability was confirmed among the report's ten high-impact
observations. This conclusion is limited to the reviewed anchors, not the
entire repository or deployed application. The Scout DOM integration test was
not executed during the original triage because jsdom was unavailable.

## Coverage gaps

The paid check records 111 resolved packages queried against OSV, with no
medium-or-higher findings reported. Python requirements remain unresolved.
The stale bundled snapshot belongs to the included free baseline; do not
misrepresent it as the paid live OSV lookup.

HTML-injection analysis completed for 31 of 36 eligible files. Four exceeded
the file limit and one exceeded the syntax budget. Large manually vendored
CTT bundles require their own version/advisory inventory; npm test dependencies
do not represent all code shipped in the browser extension.

## Next Drydock changes (separate repository/PR)

1. Preserve the resolved repository ref, exact commit and archive checksum.
   Show the component and release version actually inspected.
2. Group repeated observations by source anchor and root cause. Repeated LLM
   output must not inflate the count of independent problems.
3. Distinguish a risky sink from demonstrated untrusted input reaching it.
   Recognize bounded literal identifier lists and context-appropriate escaping
   only when supported by source evidence; unresolved cases stay unresolved.
4. Reject or flag internally contradicted model narratives, including the
   supplied CORS example. Do not attach irrelevant context-check explanations.
5. Show source and dependency exclusions per component, including manually
   bundled libraries, without turning missing coverage into a clean result.
6. Add regression fixtures from these bounded examples, paired with unsafe
   variants, so noise reduction cannot silently suppress real vulnerabilities.

An independent repository issue was also noticed: the Timeweb workflow selects
`origin/main` after CI, and deploy/deploy.sh pulls again. Pinning deployment to
the tested revision requires a separate coordinated change to both files.
This source-consolidation change does not alter deployment behavior.
