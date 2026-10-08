export type EnvironmentDiagnosisField =
  | "usernameSelector"
  | "passwordSelector"
  | "submitSelector"
  | "successSelector";
export interface EnvironmentDiagnosis {
  code: string;
  title: string;
  detail: string;
  action:
    | "connect_preview"
    | "edit_environment"
    | "edit_login"
    | "manage_credentials"
    | "retry";
  field?: EnvironmentDiagnosisField;
  matchCount?: number;
  origin?: string;
}
export interface EnvironmentCheck {
  name: string;
  passed: boolean;
}

// Browser output is untrusted. Only these controller-owned explanations reach the UI.
const catalog = {
  app_health_unreachable: [
    "The runner cannot reach the test app",
    "Check that the app listens on 0.0.0.0 and that Docker bridge networking and the host firewall allow containers to communicate. The PM has not started.",
    "edit_environment",
  ],
  app_health_response: [
    "The test app's health check failed",
    "The health endpoint returned an unsuccessful response. Check its path and the app's required test inputs, then test again.",
    "edit_environment",
  ],
  app_exited: [
    "The test app stopped during startup",
    "Check its Docker startup command and required test inputs. The app stopped before the runner could open it; no PM was started.",
    "edit_environment",
  ],
  app_memory_limit: [
    "The test app ran out of memory",
    "The app exceeded its Docker memory limit during startup. Reduce startup memory or adjust its test recipe, then test again.",
    "edit_environment",
  ],
  environment_failed: [
    "The test app could not be prepared",
    "Check its Docker recipe, source access and required test inputs. No PM was started.",
    "edit_environment",
  ],
  login_controls_changed: [
    "A sign-in step needs updating",
    "A saved sign-in step no longer identifies one usable control in this app. Review the detected login flow; the saved credentials were preserved.",
    "edit_login",
  ],
  identity_mismatch: [
    "The signed-in identity did not match",
    "The test account or workspace did not match its configured assertion. Check the chosen account and workspace; the identity requirement was preserved.",
    "edit_login",
  ],
  public_confirmation: [
    "The sign-in marker also appears publicly",
    "The selected confirmation appears before authentication. Choose a marker exclusive to the signed-in app before relying on this account.",
    "edit_login",
  ],
  receiving_context_failed: [
    "The runner could not confirm its signed-in browser",
    "Authentication did not establish the browser context used for testing. Retry on the selected agent service; no signed-in readiness was recorded.",
    "retry",
  ],
  session_expired: [
    "The test session expired",
    "The test app signed the account out before access could be confirmed. Reconnect the account and check the app's session policy.",
    "edit_login",
  ],
  preview_credential_missing: [
    "Preview access needs reconnecting",
    "The saved preview-access reference has no credential value. Connect preview access, then test again.",
    "connect_preview",
  ],
  vercel_protection: [
    "Vercel protection stopped the browser",
    "The browser reached Vercel's deployment protection instead of the app. Connect preview access, then test again.",
    "connect_preview",
  ],
  preview_credential_rejected: [
    "Vercel did not accept saved preview access",
    "The browser sent the saved preview credential but still reached Vercel protection. Update the automation bypass credential in Connections, then test again.",
    "manage_credentials",
  ],
  account_credentials_missing: [
    "Test credentials are missing",
    "Save the selected test-account username and password in Connections, then retry.",
    "manage_credentials",
  ],
  browser_unavailable: [
    "The browser could not start",
    "Check Docker and the browser worker on the selected agent service, then retry.",
    "retry",
  ],
  storage_redaction_limit: [
    "The app's browser storage exceeds the privacy limit",
    "The private browser could not safely redact this much stored data. Reduce cached data for the dedicated test account, then test again. No browser content was shared with the gremlin; this does not mean the password is wrong.",
    "edit_environment",
  ],
  environment_unreachable: [
    "The app could not be reached",
    "The browser could not finish opening the app. Check the test address and network access from the worker.",
    "edit_environment",
  ],
  application_http_error: [
    "The app returned an error",
    "The test address returned an unsuccessful HTTP response. Check the deployment and test address. This alone does not identify deployment protection.",
    "edit_environment",
  ],
  external_redirect: [
    "The app redirected to another site",
    "The test address redirected outside the selected app origin. Choose the final test address; browser credentials stay on that origin.",
    "edit_environment",
  ],
  login_external_redirect: [
    "Sign-in left the test app",
    "The login flow redirected outside the selected app origin. Use a dedicated password login on the test app; external SSO is not supported by this check.",
    "edit_login",
  ],
  login_http_error: [
    "The login page returned an error",
    "The saved login path returned an unsuccessful HTTP response. Check that it opens a password login on the selected test app.",
    "edit_login",
  ],
  selector_not_found: [
    "A login control was not found",
    "No element matched this login selector. Check the selector against the password sign-in page.",
    "edit_login",
  ],
  selector_ambiguous: [
    "A login selector matched several elements",
    "Use a selector that matches exactly one login control on this page.",
    "edit_login",
  ],
  selector_unusable: [
    "A login control could not be used",
    "The matching control was hidden, disabled, or could not accept the requested action. Check the selector and login page.",
    "edit_login",
  ],
  login_credentials_rejected: [
    "The app rejected the credentials",
    "The sign-in request was rejected and the page reported invalid credentials. Check the saved test account in Connections.",
    "manage_credentials",
  ],
  login_rejected: [
    "The app rejected sign-in",
    "The sign-in request returned an error, but the browser could not confirm the cause. Check the app's login configuration and test account.",
    "edit_login",
  ],
  login_origin_rejected: [
    "The app does not trust this preview's sign-in origin",
    "The app rejected the preview origin during sign-in. Check this origin against your authentication provider's trusted domains and the app's origin policy, then test again. This is an app authentication setting; it does not prove the password is wrong.",
    "edit_login",
  ],
  success_not_found: [
    "Signed-in confirmation was not found",
    "The saved signed-in selector did not match an element after submitting the form. Check that selector and whether sign-in completed; a timeout does not prove the password is wrong.",
    "edit_login",
  ],
  success_not_visible: [
    "Signed-in confirmation stayed hidden",
    "The saved signed-in selector matched an element that did not become visible. Choose an element visible only after successful sign-in.",
    "edit_login",
  ],
  login_incomplete: [
    "Sign-in did not finish settling",
    "The signed-in element appeared, but the password form did not close within 15 seconds. Check whether the app finished signing in and whether the saved selectors identify the correct controls.",
    "edit_login",
  ],
  login_unverified: [
    "Sign-in could not be confirmed",
    "The app opened, but a test account could not sign in. Check its saved credentials, login controls and signed-in confirmation.",
    "edit_login",
  ],
  invalid_evidence: [
    "The browser result was incomplete",
    "The browser did not return valid verification evidence. Retry the check; this environment is still unverified.",
    "retry",
  ],
  cleanup_pending: [
    "Browser cleanup is pending",
    "Check Docker on the controller before retrying. Completed checks were retained, but verification did not finish.",
    "retry",
  ],
} as const;

export function environmentDiagnosis(
  value: unknown,
): EnvironmentDiagnosis | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.code !== "string" || !Object.hasOwn(catalog, row.code))
    return undefined;
  const code = row.code as keyof typeof catalog;
  const field = row.field;
  const fields = [
    "usernameSelector",
    "passwordSelector",
    "submitSelector",
    "successSelector",
  ];
  if (
    field !== undefined &&
    (typeof field !== "string" || !fields.includes(field))
  )
    return undefined;
  const count = row.matchCount;
  if (
    count !== undefined &&
    (typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > 10000)
  )
    return undefined;
  const selector = code.startsWith("selector_");
  const confirmation =
    code.startsWith("success_") || code === "login_incomplete";
  if (selector && !field) return undefined;
  if (confirmation && field !== "successSelector") return undefined;
  if (
    !selector &&
    !confirmation &&
    (field !== undefined || count !== undefined)
  )
    return undefined;
  if (
    (code === "selector_not_found" || code === "success_not_found") &&
    count !== 0
  )
    return undefined;
  if (code === "selector_ambiguous" && (typeof count !== "number" || count < 2))
    return undefined;
  const [title, detail, action] = catalog[code];
  const origin = row.origin;
  if (origin !== undefined) {
    if (
      code !== "login_origin_rejected" ||
      typeof origin !== "string" ||
      origin.length > 512
    )
      return undefined;
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
        return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    code,
    title,
    detail,
    action,
    ...(field ? { field: field as EnvironmentDiagnosisField } : {}),
    ...(count !== undefined ? { matchCount: count as number } : {}),
    ...(origin ? { origin: origin as string } : {}),
  };
}

export function environmentChecks(
  value: unknown,
): EnvironmentCheck[] | undefined {
  if (!Array.isArray(value) || value.length > 160) return undefined;
  const name =
    /^(Browser opens application|Test account [1-8] signs in|Test account [1-8]: (login page opens|username field|password field|submit control|signed-in confirmation))$/;
  const checks: EnvironmentCheck[] = [];
  for (const check of value) {
    if (
      !check ||
      typeof check !== "object" ||
      typeof check.name !== "string" ||
      !(
        name.test(check.name) ||
        /^(?:Test account [1-8]: )?(?:Browser opens application|Login page opens|Sign-in step (?:[1-9]|1[0-2])|Signed-out context cannot see the protected confirmation|Protected route opens with the expected test identity|PM browser receives the verified context)$/.test(
          check.name,
        )
      ) ||
      typeof check.passed !== "boolean"
    )
      return undefined;
    checks.push({ name: check.name, passed: check.passed });
  }
  return checks;
}
