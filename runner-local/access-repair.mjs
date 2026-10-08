import { parsePasswordRecipe } from "./access-schema.mjs";

// Trusted, bounded DOM inspection. No model code, credential values, navigation,
// success markers or identity assertions are accepted as repair inputs.
export async function suggestLoginControlRepair(page, access) {
  const observed = await page.evaluate(() => {
    const visible = (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden" &&
      !element.disabled &&
      !element.readOnly;
    const username = (element) =>
      element.tagName === "INPUT" &&
      (element.autocomplete === "username" ||
        element.autocomplete === "email" ||
        element.type === "email");
    const password = (element) =>
      element.tagName === "INPUT" &&
      element.type === "password" &&
      element.autocomplete !== "new-password";
    const isSubmit = (element) => {
      const label =
        element.getAttribute("aria-label") ||
        (element.tagName === "INPUT" ? element.value : element.textContent);
      return (
        /^(sign\s*in|log\s*in|login)$/i.test((label || "").trim()) &&
        (element.tagName === "BUTTON" || element.type === "submit")
      );
    };
    const forms = [...document.querySelectorAll("form")]
      .map((form) => {
        const controls = [...form.elements].filter(visible);
        return {
          form,
          usernames: controls.filter(username),
          passwords: controls.filter(password),
          allPasswords: controls.filter(
            (element) => element.type === "password",
          ),
          submits: controls.filter(isSubmit),
        };
      })
      .filter((item) => item.usernames.length || item.passwords.length);
    // Ambiguous forms or controls require a reviewed recipe, not a best guess.
    if (forms.length !== 1) return null;
    const only = forms[0];
    if (
      only.usernames.length !== 1 ||
      only.passwords.length !== 1 ||
      only.allPasswords.length !== 1 ||
      only.submits.length !== 1
    )
      return null;
    const selector = (element) => {
      // Structural selectors contain no app-provided strings or input values.
      // The fresh-context verification below proves they still select this form.
      const parts = [];
      for (
        let node = element;
        node && node !== document.documentElement;
        node = node.parentElement
      ) {
        const tag = node.tagName.toLowerCase();
        const siblings = [...node.parentElement.children].filter(
          (item) => item.tagName === node.tagName,
        );
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      }
      return `html > ${parts.join(" > ")}`;
    };
    return {
      usernameSelector: selector(only.usernames[0]),
      passwordSelector: selector(only.passwords[0]),
      submitSelector: selector(only.submits[0]),
    };
  });
  if (!observed) return undefined;
  const { kind: _kind, accounts: _accounts, ...original } = access;
  const candidate = { ...original, ...observed };
  if (original.steps) {
    // A multi-step recipe may open its modal first. Only credential controls and
    // its explicitly saved final submit selector are eligible to change.
    candidate.steps = original.steps.map((step) =>
      step.kind === "fill"
        ? { ...step, selector: observed[`${step.credential}Selector`] }
        : step.kind === "click" && step.selector === original.submitSelector
          ? { ...step, selector: observed.submitSelector }
          : { ...step },
    );
  }
  const recipe = parsePasswordRecipe(candidate);
  const changes = Object.keys(observed)
    .filter((field) => original[field] !== recipe[field])
    .map((field) => ({ field, from: original[field], to: recipe[field] }));
  return changes.length
    ? { kind: "login-controls", changes, recipe }
    : undefined;
}
