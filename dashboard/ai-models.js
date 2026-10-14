"use strict";
(() => {
  const catalogs = new WeakMap();
  const modelId = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
  window.createAiModelChoices = ({ api }) => {
    let cache = catalogs.get(api);
    if (!cache) {
      cache = new Map();
      catalogs.set(api, cache);
    }
    const read = (provider) => {
      if (!cache.has(provider)) {
        const entry = { pending: true, models: [], source: "", message: "" };
        cache.set(provider, entry);
        entry.promise = Promise.resolve()
          .then(() => api(`/api/ai/models?provider=${provider}`))
          .then((view) => {
            if (
              view?.provider !== provider ||
              !Array.isArray(view.models) ||
              !["provider", "supported"].includes(view.source)
            )
              throw new Error("Invalid model catalog.");
            entry.models = view.models
              .filter(
                (item) => modelId(item?.id) && typeof item.label === "string",
              )
              .slice(0, 100)
              .map((item) => ({
                id: item.id,
                label: item.label.slice(0, 120),
              }));
            entry.source = view.source;
            entry.message =
              typeof view.message === "string"
                ? view.message.slice(0, 400)
                : "";
          })
          .catch(() => {
            entry.message =
              "Model choices could not load. Provider default and any previously saved choice are kept. Refresh connection status to try again.";
          })
          .finally(() => {
            entry.pending = false;
          });
      }
      return cache.get(provider);
    };
    return {
      bind(select, hint) {
        let provider = "",
          savedValue = "",
          signature = "",
          generation = 0;
        const option = (value, label, disabled = false) => {
          const element = document.createElement("option");
          element.value = value;
          element.textContent = label;
          element.disabled = disabled;
          return element;
        };
        function draw(value) {
          const catalog = provider ? cache.get(provider) : null;
          const next = JSON.stringify([
            provider,
            value,
            catalog?.models,
            catalog?.pending,
            catalog?.message,
          ]);
          if (next === signature) return;
          signature = next;
          const options = [option("", "Provider default")];
          for (const model of catalog?.models || [])
            options.push(option(model.id, model.label));
          if (value && !catalog?.models.some((item) => item.id === value))
            options.push(
              option(
                value,
                catalog?.pending
                  ? `${value} · Previously saved (checking availability)`
                  : `${value} · Unavailable${value === savedValue ? " (previously saved)" : ""}`,
                true,
              ),
            );
          select.replaceChildren(...options);
          select.value = value;
          hint.textContent = !provider
            ? "The inherited choice includes its model."
            : catalog?.pending
              ? "Loading model choices…"
              : [
                  catalog?.source === "provider"
                    ? "Provider catalog · availability depends on your account."
                    : catalog?.source === "supported"
                      ? "Supported model choices · live availability has not been verified."
                      : "",
                  catalog?.message,
                ]
                  .filter(Boolean)
                  .join(" ");
        }
        return {
          set(nextProvider, value = "") {
            if (!["claude", "codex", ""].includes(nextProvider)) return;
            provider = nextProvider;
            savedValue = value;
            const current = ++generation;
            const entry = provider ? read(provider) : null;
            draw(value);
            if (entry?.pending)
              void entry.promise.then(() => {
                if (current === generation) draw(select.value);
              });
          },
          allowed(value) {
            return (
              value === "" ||
              (modelId(value) &&
                (value === savedValue ||
                  cache
                    .get(provider)
                    ?.models.some((item) => item.id === value)))
            );
          },
          refresh() {
            if (provider && !cache.get(provider)?.pending)
              cache.delete(provider);
            this.sync();
          },
          sync() {
            const current = ++generation;
            const entry = provider ? read(provider) : null;
            draw(select.value);
            if (entry?.pending)
              void entry.promise.then(() => {
                if (current === generation) draw(select.value);
              });
          },
        };
      },
    };
  };
})();
