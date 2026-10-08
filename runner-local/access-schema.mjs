/** Shared, data-only authentication recipe validator. Never accepts executable code. */
const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 500) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const invalid = () =>
  new Error(
    "Use a bounded same-origin password login recipe with valid selectors.",
  );
export function validLoginPath(value) {
  if (!text(value) || !value.startsWith("/") || /[\\?#]/.test(value))
    return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      !decoded.startsWith("//") &&
      !/[\\\u0000-\u001f\u007f]/.test(decoded) &&
      new URL(value, "https://test.invalid").origin === "https://test.invalid"
    );
  } catch {
    return false;
  }
}
export function parsePasswordRecipe(value) {
  const keys = [
    "loginPath",
    "usernameSelector",
    "passwordSelector",
    "submitSelector",
    "successSelector",
    "authenticatedPath",
    "steps",
  ];
  if (
    !record(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !validLoginPath(value.loginPath)
  )
    throw invalid();
  for (const key of keys.slice(1, 5)) if (!text(value[key])) throw invalid();
  if (
    value.authenticatedPath !== undefined &&
    !validLoginPath(value.authenticatedPath)
  )
    throw invalid();
  const result = Object.fromEntries(
    keys.slice(0, 5).map((key) => [key, value[key]]),
  );
  if (value.authenticatedPath !== undefined)
    result.authenticatedPath = value.authenticatedPath;
  if (value.steps !== undefined) {
    if (
      !Array.isArray(value.steps) ||
      !value.steps.length ||
      value.steps.length > 12
    )
      throw invalid();
    const fills = { username: 0, password: 0 };
    let passwordAt = -1,
      submitted = false;
    result.steps = value.steps.map((step, index) => {
      if (!record(step)) throw invalid();
      const allowed = {
        navigate: ["kind", "path"],
        click: ["kind", "selector"],
        fill: ["kind", "selector", "credential"],
        select: ["kind", "selector", "value"],
        wait: ["kind", "selector", "state"],
      }[step.kind];
      if (
        !allowed ||
        Object.keys(step).some((key) => !allowed.includes(key)) ||
        Object.keys(step).length !== allowed.length
      )
        throw invalid();
      if (step.kind === "navigate") {
        if (!validLoginPath(step.path) || passwordAt >= 0) throw invalid();
      } else if (!text(step.selector)) throw invalid();
      if (step.kind === "fill") {
        if (!["username", "password"].includes(step.credential))
          throw invalid();
        fills[step.credential]++;
        if (step.credential === "password") passwordAt = index;
      }
      if (step.kind === "click" && passwordAt >= 0) submitted = true;
      if (step.kind === "select" && !text(step.value, 200)) throw invalid();
      if (step.kind === "wait" && !["visible", "hidden"].includes(step.state))
        throw invalid();
      return { ...step };
    });
    if (fills.username !== 1 || fills.password !== 1 || !submitted)
      throw invalid();
  }
  return result;
}
export function parseIdentityAssertions(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 4)
    throw invalid();
  return value.map((item) => {
    if (
      !record(item) ||
      !text(item.selector) ||
      !["principal", "tenant"].includes(item.kind)
    )
      throw invalid();
    const keys =
      item.kind === "principal"
        ? ["kind", "selector"]
        : ["kind", "selector", "equals"];
    if (
      Object.keys(item).some((key) => !keys.includes(key)) ||
      Object.keys(item).length !== keys.length ||
      (item.kind === "tenant" && !text(item.equals, 200))
    )
      throw invalid();
    return { ...item };
  });
}
