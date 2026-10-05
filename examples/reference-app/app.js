const account = document.querySelector("#account"),
  list = document.querySelector("#tasks"),
  status = document.querySelector("#status");
async function request(path, init = {}) {
  const result = await fetch(path, {
    ...init,
    headers: { "x-demo-user": account.value, ...init.headers },
  });
  const body = await result.json();
  if (!result.ok) throw new Error(body.error);
  return body;
}
async function load() {
  try {
    const result = await request("/api/tasks");
    list.replaceChildren(
      ...result.tasks.map((task) => {
        const li = document.createElement("li");
        li.textContent = task.title;
        return li;
      }),
    );
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  }
}
account.addEventListener("change", load);
document.querySelector("#upload").addEventListener("click", async () => {
  try {
    const file = document.querySelector("#csv").files[0];
    if (!file) throw new Error("Choose a CSV file first.");
    const result = await request("/api/import", {
      method: "POST",
      body: await file.text(),
      headers: { "Content-Type": "text/csv" },
    });
    await load();
    status.textContent = `Imported ${result.added} tasks.`;
  } catch (error) {
    status.textContent = error.message;
  }
});
load();
