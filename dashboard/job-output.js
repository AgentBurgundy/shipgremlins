"use strict";

(() => {
  // Each resource progresses independently: a screenshot download must not hold
  // up the visible timeline or log tail. Selection changes invalidate all work.
  window.createJobOutput = ({ load, render, onError, onBusy }) => {
    const resources = ["activity", "logs", "artifacts"];
    const requests = new Map();
    const signatures = new Map();
    let selected = "";
    let generation = 0;
    let paused = true;
    const busy = () => onBusy?.(requests.size > 0);
    function cancel() {
      generation += 1;
      for (const request of requests.values()) request.controller.abort();
      requests.clear();
      busy();
    }
    function refresh() {
      if (!selected || paused) return Promise.resolve();
      const id = selected;
      const revision = generation;
      return Promise.allSettled(
        resources.map((resource) => {
          if (requests.has(resource)) return requests.get(resource).promise;
          const controller = new AbortController();
          const isCurrent = () =>
            selected === id && generation === revision && !paused;
          const request = { controller, promise: null };
          requests.set(resource, request);
          busy();
          request.promise = Promise.resolve()
            .then(() => load(resource, id, controller.signal))
            .then(async (value) => {
              if (!isCurrent()) return;
              const signature = JSON.stringify(value);
              if (signatures.get(resource) !== signature) {
                await render(resource, value, {
                  id,
                  signal: controller.signal,
                  isCurrent,
                });
                if (!isCurrent()) return;
                signatures.set(resource, signature);
              }
              onError?.(resource, null);
            })
            .catch((error) => {
              if (isCurrent()) onError?.(resource, error);
            })
            .finally(() => {
              if (requests.get(resource) === request) {
                requests.delete(resource);
                busy();
              }
            });
          return request.promise;
        }),
      );
    }
    return {
      select(id) {
        if (selected === id) return false;
        cancel();
        selected = id;
        signatures.clear();
        return true;
      },
      refresh,
      resume() {
        paused = false;
        return refresh();
      },
      pause() {
        paused = true;
        cancel();
      },
      close() {
        paused = true;
        cancel();
        selected = "";
        signatures.clear();
      },
      invalidate(resource) {
        signatures.delete(resource);
      },
    };
  };
})();
