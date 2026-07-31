# SSO Setup Guide

This guide covers configuring Single Sign-On (SSO) for ryasai Chatbot. Two protocols are supported:

- **OIDC** (OpenID Connect) — modern, recommended for Keycloak, Azure AD/Entra ID, Auth0, Google
- **SAML 2.0** — for legacy enterprise IdPs (AD FS, Shibboleth, Okta SAML)

Both can be configured simultaneously. The login page shows buttons for whichever protocols are configured.

---

## OIDC (OpenID Connect)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_ISSUER` | Yes | IdP issuer URL (e.g. `https://keycloak.example.com/realms/myrealm`) |
| `OIDC_CLIENT_ID` | Yes | Client ID registered at the IdP |
| `OIDC_CLIENT_SECRET` | Yes* | Client secret (*not required for public clients with PKCE-only) |
| `OIDC_REDIRECT_URI` | Yes | Must be `https://your-chatbot-url/api/auth/sso/callback` |

The app auto-discovers endpoints from `{OIDC_ISSUER}/.well-known/openid-configuration`.
PKCE (Proof Key for Code Exchange) is used by default for added security.

### Provider Setup

#### Keycloak (self-hosted, air-gapped friendly)

1. In Keycloak admin, create a new Client for your realm.
2. Client ID: set `OIDC_CLIENT_ID` to this value.
3. Client authentication: Enabled (confidential access type).
4. Valid redirect URIs: `https://your-chatbot-url/api/auth/sso/callback`
5. Copy the client secret → set `OIDC_CLIENT_SECRET`.
6. Issuer URL: `https://keycloak.example.com/realms/myrealm` → set `OIDC_ISSUER`.
7. Set `OIDC_REDIRECT_URI` to `https://your-chatbot-url/api/auth/sso/callback`.
8. Restart the chatbot. The "Sign in with SSO" button appears on the login page.

#### Azure AD / Entra ID

1. Azure portal → App registrations → New registration.
2. Redirect URI: Web → `https://your-chatbot-url/api/auth/sso/callback`.
3. Client ID → `OIDC_CLIENT_ID`.
4. Certificates & secrets → New client secret → copy value → `OIDC_CLIENT_SECRET`.
5. Issuer: `https://login.microsoftonline.com/{tenant-id}/v2.0` → `OIDC_ISSUER`.
6. Set `OIDC_REDIRECT_URI`.
7. Restart.

#### Auth0

1. Auth0 dashboard → Applications → Create Application → Regular Web App.
2. Settings → Allowed Callback URLs: `https://your-chatbot-url/api/auth/sso/callback`.
3. Client ID → `OIDC_CLIENT_ID`, Client Secret → `OIDC_CLIENT_SECRET`.
4. Issuer: `https://your-domain.auth0.com` → `OIDC_ISSUER`.
5. Set `OIDC_REDIRECT_URI`.
6. Restart.

#### Google Workspace

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID.
2. Application type: Web application.
3. Authorized redirect URIs: `https://your-chatbot-url/api/auth/sso/callback`.
4. Client ID → `OIDC_CLIENT_ID`, Client Secret → `OIDC_CLIENT_SECRET`.
5. Issuer: `https://accounts.google.com` → `OIDC_ISSUER`.
6. Set `OIDC_REDIRECT_URI`.
7. Restart.

### Testing

1. Set all 4 env vars in `.env`.
2. Restart the chatbot (`bun run dev` or `bash start.sh`).
3. Navigate to `/login` — "Sign in with SSO" button should appear.
4. Click it — should redirect to your IdP.
5. After authentication, redirect back to the chatbot dashboard.

---

## SAML 2.0

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SAML_SP_ENTITY_ID` | Yes | Our entity ID (e.g. `https://chatbot.company.com`) |
| `SAML_SP_CALLBACK_URL` | Yes | Our ACS URL (e.g. `https://chatbot.company.com/api/auth/saml/callback`) |
| `SAML_IDP_ENTRY_POINT` | Yes* | IdP SSO URL (*auto-discovered if `SAML_IDP_METADATA_URL` is set) |
| `SAML_IDP_CERT` | Yes* | IdP public cert PEM (*auto-discovered if metadata URL is set) |
| `SAML_IDP_METADATA_URL` | No | IdP metadata XML URL — auto-discovers entryPoint + cert |
| `SAML_SP_CERT` | No | Our cert for signing AuthnRequests (if IdP requires signed requests) |
| `SAML_SP_PRIVATE_KEY` | No | Our private key for signing AuthnRequests |

### Setup Steps

1. Set `SAML_SP_ENTITY_ID` and `SAML_SP_CALLBACK_URL` to your chatbot's URL.
2. Get your SP metadata URL: `https://your-chatbot-url/api/auth/saml/metadata`.
3. Give this URL to your IdP administrator (or download the XML at that URL).
4. Get the IdP metadata URL from your IdP admin (or the IdP cert + entry point URL manually).
5. Set `SAML_IDP_METADATA_URL` (recommended) or set `SAML_IDP_ENTRY_POINT` + `SAML_IDP_CERT` manually.
6. Restart the chatbot. "Sign in with SAML" button appears on login page.

### Provider Notes

#### AD FS (on-prem)

1. AD FS Management → Add Relying Party Trust.
2. Import SP metadata from the URL: `https://chatbot/api/auth/saml/metadata`.
3. Set claim rules: map AD `Email-Address` → `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`, `Common-Name` → name claim.
4. Get the AD FS metadata URL: `https://adfs.example.com/FederationMetadata/2007-06/FederationMetadata.xml`.
5. Set `SAML_IDP_METADATA_URL` to that URL.

#### Shibboleth IdP

1. Add the SP in `relying-party.xml` using the SP metadata URL.
2. Configure attribute release in `attribute-filter.xml` for the SP entity ID.
3. Set `SAML_IDP_METADATA_URL` to `https://idp.example.com/idp/shibboleth`.

#### Okta SAML

1. Okta admin → Applications → Create App Integration → SAML 2.0.
2. ACS URL: `https://chatbot/api/auth/saml/callback`.
3. SP Entity ID: `SAML_SP_ENTITY_ID` value.
4. Set `SAML_IDP_METADATA_URL` to the Okta metadata URL (available on the app's Sign On tab).

### Troubleshooting

- **Signature validation error**: Ensure `SAML_IDP_CERT` is the full PEM cert (with `-----BEGIN CERTIFICATE-----` headers). If using metadata URL, verify it's reachable from the chatbot server.
- **Clock skew errors**: IdP and chatbot server clocks must be within 60 seconds. Use NTP.
- **Attribute mapping**: If email is missing, check that the IdP releases the email attribute. The app checks both URI format (`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`) and OID format (`urn:oid:0.9.2342.19200300.100.1.3`).
- **Audience restriction error**: Ensure `SAML_SP_ENTITY_ID` matches exactly what's configured at the IdP.
