import { animate } from "motion/mini";
import { createDashboardMotion } from "./motion-controller.mjs";

function install() {
  window.dashboardMotion?.destroy();
  window.dashboardMotion = createDashboardMotion({ window, document, animate });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", install, { once: true });
else install();
