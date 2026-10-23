# LOCKqz Phase 2 — LTI 1.3 tool build plan (ready to build when USC approves)

Goal: the zero-effort teacher experience — Brightspace SSO, a class roster with green/red (installed/not)
dots, and auto-set quiz passwords. Untestable until USC registers the tool and gives us a Client ID, so this
is the plan + the registration fields; we build and test once USC says yes.

## What USC gives us (from registering an LTI 1.3 Advantage tool)
- Issuer (platform id), Client ID, Deployment ID
- OIDC authentication endpoint, Brightspace Keyset (JWKS) URL, OAuth2 access-token URL, OAuth2 audience
- NRPS enabled on the registration; (optionally) a scoped Valence API app id/key/user context for quizzing

## What we give USC
- OIDC login-initiation URL:  https://lockqz.pages.dev/lti/login
- Redirect/launch URL:        https://lockqz.pages.dev/lti/launch
- Public keyset (JWKS) URL:    https://lockqz.pages.dev/lti/jwks  (our public signing key)

## Endpoints to build (Cloudflare Pages Functions, alongside the current API)
- GET/POST /lti/login  — OIDC third-party login initiation: redirect to Brightspace auth endpoint with
  state + nonce (PKCE-style), store state briefly in D1/KV.
- POST /lti/launch — receive the id_token (JWT), validate signature against Brightspace JWKS, check iss/aud/
  nonce/exp, read the claims (user id, roles, context/course id, deployment id). Instructor launch → show the
  roster dashboard; student launch (if ever) → show install status.
- GET /lti/jwks — serve our public RSA key (we hold the private key as a Pages secret).
- Service calls (server→Brightspace, OAuth2 client-credentials with our key):
  - NRPS: GET the course membership (names + roles + Brightspace user ids) → cross-reference our `devices`
    table (keyed by Brightspace user id once we capture it) → render green (installed) / red (not) per student.
  - Valence quizzing (optional): for each quiz in the course, set the access password to the course's LOCKqz
    password via the quiz-config update API. Confirmed D2L supports updating a quiz's config properties
    (password is one); quiz-attempt automation is NOT supported and is not needed.

## Data model additions
- devices: add `bs_user_id` (Brightspace user id) so installs map to roster rows. The helper/extension learns
  it at an LTI student launch, or the student links once via an LTI launch button.
- lti_state: short-lived OIDC state/nonce store (D1 table or KV, TTL ~5 min).
- Store our RSA private key as a Pages secret (LTI_PRIVATE_KEY); publish the public half at /lti/jwks.

## Libraries
- JWT verify / JWKS and OIDC in a Worker: use `jose` (works on Workers) for JWT + JWKS. OAuth2
  client-credentials to Brightspace token endpoint for NRPS/Valence.

## Dashboard change
- Replace the teacher-key login with LTI SSO (launch from Brightspace). The existing dashboard tables
  (roster, activity) stay; roster gains the green/red dot column fed by NRPS.

## Order of work (once USC registers)
1. /lti/jwks + key pair. 2. /lti/login + /lti/launch with jose validation. 3. NRPS membership call + dot
   rendering. 4. (if approved) Valence quiz-password auto-set. 5. Capture bs_user_id into devices. 6. Swap the
   dashboard to SSO.
