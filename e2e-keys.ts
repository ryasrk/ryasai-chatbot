/**
 * Fixed Ed25519 test keypair for the e2e License-Validator stub.
 *
 * Lives OUTSIDE e2e/ (which imports @playwright/test in some files) so
 * playwright.config.ts can read it without dragging test-only types into
 * `next build` typechecking — the production Docker image has no playwright
 * installed and the import broke the image build.
 *
 * Test-only; never a production secret. The app under test receives this
 * public key via LICENSE_SIGNING_PUBLIC_KEY in the e2e web server env.
 */
export const E2E_LICENSE_PUBKEY_HEX =
  '302a300506032b657003210030d9afe8c7f308d2d4cbdb0749ca5f8829b5fd629e14ac837f39bcee53168e80'

export const E2E_LICENSE_PRIVKEY_HEX =
  '302e020100300506032b6570042204209c969e5fa3b454cc4d7718cebcb07732e3c3671f66de8d533ba12cd3c7961832'
