# Email configuration

SMTP and OTP settings can now be entered through the website. First-run installation accepts SMTP configuration at `/setup`; existing authorized administrators use **Email delivery → Configure email and OTP**. The test-and-save workflow requires successful SMTP verification, an accepted test recipient, and administrator confirmation of receipt. Settings are AES-256-GCM encrypted outside the web root; saved passwords are never returned to the browser. Environment SMTP values remain a fallback for legacy deployments. Website-saved values take precedence.

Settings apply to new sends without restarting. A blank password preserves the existing secret only for the same host and username. Tests expire after ten minutes and are tied to the administrator. Changes are audited without credentials. OTP codes are not stored in delivery logs or console output, and OTP attempts are excluded from background email retries. Migration 008 removes previously stored OTP payloads.

See WEBSITE_SETUP.md for secure storage and operator setup. Actual provider delivery remains unverified until real credentials are entered and the test is received. Test-suite SMTP acceptance is mocked and is not proof of external delivery.
