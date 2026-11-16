import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

// The second machine starts new threads on the replay agent's "Plan and reads" recording.
const secondMachineDefaultsToPlanAndReads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(SECOND_HOME, "userdata/settings.json");
  const settings = yield* decodeSettings(yield* fs.readFileString(settingsPath));
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      defaultModelSelection: { instanceId: "devReplay", model: "todo-list" },
    }),
  );
});

test(
  "A new draft takes the other machine's default model when it moves there",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const primary = makeState(T3_HOME);
    const second = makeState(SECOND_HOME);
    // Machines share a project through its repository, which needs a remote to be named by.
    const workspace = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(T3_HOME, "workspaces"), { recursive: true });
        const directory = yield* fs.makeTempDirectory({
          directory: path.join(T3_HOME, "workspaces"),
          prefix: "demo-",
        });
        yield* fs.writeFileString(path.join(directory, "README.md"), "");
        return directory;
      }),
    );
    const git = (args: ReadonlyArray<string>) => runPromise(run("git", args, { cwd: workspace }));
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["remote", "add", "origin", "https://github.com/scenario/demo.git"]);
    await git(["add", "--all"]);
    await git([
      "-c",
      "user.name=Scenario",
      "-c",
      "user.email=scenario@example.invalid",
      "commit",
      "--quiet",
      "--message",
      "Initial commit",
    ]);
    await runPromise(primary.cli(["project", "add", workspace, "--title", "demo"]));
    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      await runPromise(secondMachineDefaultsToPlanAndReads);
      await runPromise(second.cli(["project", "add", workspace, "--title", "demo"]));

      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await expect(screen.getByRole("button", "More actions for Scenario")).toBeVisible({
        timeout: 60_000,
      });
      await app.open("/");
      // The draft may open on either machine; it starts on that machine's default.
      const showcase = screen.getByRole("button", "Showcase", { exact: false }).first();
      const planAndReads = screen.getByRole("button", "Plan and reads", { exact: false }).first();
      await expect(showcase.or(planAndReads)).toBeVisible();
      const otherDefault = (await planAndReads.isVisible()) ? showcase : planAndReads;
      await app.screenshot("before-machine-switch");

      // Both machines are named Scenario; the draft runs on the checked one.
      const runOn = () => screen.getByText("Scenario").last().tap();
      const machine = (index: number) => browser.locator('[role="menuitemradio"]').nth(index);
      await runOn();
      const target = (await machine(0).getAttribute("aria-checked")) === "true" ? 1 : 0;
      await machine(target).click();
      await runOn();
      await expect(machine(target)).toHaveAttribute("aria-checked", "true");
      await browser.keyboard.press("Escape");

      await app.screenshot("after-machine-switch");
      await expect(otherDefault).toBeVisible();
    } finally {
      await server.stop();
      await runPromise(primary.cli(["project", "remove", workspace, "--force"]));
    }
  },
);
