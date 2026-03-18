import blessed from "blessed";
import chokidar, { FSWatcher } from "chokidar";
import { Command } from "commander";
import detectPort from "detect-port";
import fg from "fast-glob";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

type Framework = "expo-router";

interface RawCliOptions {
  projectRoot: string;
  baseFile: string;
  targetComponent: string;
  out: string;
  framework: Framework;
  ignore: string;
  watch?: boolean;
  port?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  watchDebounceMs?: string;
  treeCli?: string;
  clonerCli?: string;
  diagnosticSeconds?: string;
}

interface ResolvedOptions {
  projectRoot: string;
  baseFile: string;
  targetComponent: string;
  out: string;
  framework: Framework;
  ignoreList: string[];
  watch: boolean;
  port: number;
  packageManager: "npm" | "pnpm" | "yarn";
  watchDebounceMs: number;
  treeCli: string;
  clonerCli: string;
  treeBuildCwd: string;
  clonerBuildCwd: string;
  baseFileAbs: string;
  clonedBaseFileAbs: string;
  watchDirAbs: string;
  diagnosticSeconds: number | null;
}

interface TreeLine {
  raw: string;
  selectable: boolean;
  componentName: string | null;
}

interface ParsedTree {
  lines: TreeLine[];
  selectableCount: number;
}

function getBin(bin: "node" | "npm" | "npx" | "pnpm" | "yarn"): string {
  if (process.platform === "win32") {
    if (bin === "node") {
      return "node.exe";
    }
    return `${bin}.cmd`;
  }

  return bin;
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.(tsx|ts|jsx|js)$/, "");
}

function basenameWithoutExtension(filePath: string): string {
  return path.basename(filePath).replace(/\.(tsx|ts|jsx|js)$/, "");
}

function splitIgnoreList(ignore: string): string[] {
  return ignore
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function ensureDotRelative(importPath: string): string {
  if (importPath.startsWith(".")) {
    return importPath;
  }
  return `./${importPath}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function deriveTreeIgnoreList(
  baseFileRel: string,
  ignoreListProjectRelative: string[],
): string[] {
  const baseDirRel = normalizeSlashes(path.dirname(baseFileRel));

  return ignoreListProjectRelative.map((item) => {
    const clean = normalizeSlashes(item);
    const rel = normalizeSlashes(path.relative(baseDirRel, clean));
    return rel === "" ? "." : rel;
  });
}

function parseTreeOutput(rawOutput: string): ParsedTree {
  const rawLines = rawOutput.split(/\r?\n/);
  const lines: TreeLine[] = rawLines.map((line) => {
    const trimmed = line.trim();

    const fileMatch = trimmed.match(
      /^<([A-Za-z0-9_.$-]+)>\s*\{\/\*\s*\.(tsx|jsx|ts|js)\s*\*\/\}/,
    );

    if (fileMatch) {
      return {
        raw: line,
        selectable: true,
        componentName: fileMatch[1] ?? null,
      };
    }

    return {
      raw: line,
      selectable: false,
      componentName: null,
    };
  });

  return {
    lines,
    selectableCount: lines.filter((line) => line.selectable).length,
  };
}

function prefixTreeLine(line: TreeLine): string {
  if (line.selectable) {
    return `● ${line.raw}`;
  }
  return `  ${line.raw}`;
}

function computeImportPathFromClonedBaseToMirrored(
  clonedBaseFileAbs: string,
  mirroredTargetAbs: string,
): string {
  const rel = normalizeSlashes(
    path.relative(path.dirname(clonedBaseFileAbs), mirroredTargetAbs),
  );

  return ensureDotRelative(stripExtension(rel));
}

async function patchPreviewRootImport(
  clonedBaseFileAbs: string,
  newImportPath: string,
): Promise<void> {
  const source = await fs.readFile(clonedBaseFileAbs, "utf8");

  const previewImportRegex =
    /import\s+PreviewRoot\s+from\s+["'][^"']+["'];?/;

  const nextImportLine = `import PreviewRoot from "${newImportPath}";`;

  if (previewImportRegex.test(source)) {
    const next = source.replace(previewImportRegex, nextImportLine);
    await fs.writeFile(clonedBaseFileAbs, next, "utf8");
    return;
  }

  const lines = source.split(/\r?\n/);
  let lastImportIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim().startsWith("import ")) {
      lastImportIndex = i;
    }
  }

  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, nextImportLine);
  } else {
    lines.unshift(nextImportLine);
  }

  await fs.writeFile(clonedBaseFileAbs, lines.join("\n"), "utf8");
}

async function findMirroredMatchesByComponentName(
  outDir: string,
  componentName: string,
): Promise<string[]> {
  const mirroredRoot = path.join(outDir, ".visual-clone", "mirrored");

  const files = await fg(["**/*.{tsx,ts,jsx,js}"], {
    cwd: mirroredRoot,
    onlyFiles: true,
    dot: true,
  });

  return files
    .filter((file) => basenameWithoutExtension(file) === componentName)
    .map((file) => normalizeSlashes(file))
    .sort();
}

function attachStreamLogger(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (!stream) {
    return;
  }

  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (part.trim().length > 0) {
        onLine(part);
      }
    }
  });

  stream.on("end", () => {
    if (buffer.trim().length > 0) {
      onLine(buffer);
    }
  });
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

async function runCommandStreaming(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    attachStreamLogger(child.stdout, (line) => {
      stdout += `${line}\n`;
      options.onStdoutLine?.(line);
    });

    attachStreamLogger(child.stderr, (line) => {
      stderr += `${line}\n`;
      options.onStderrLine?.(line);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `Command failed: ${command} ${args.join(" ")} (exit code ${code})`,
        ),
      );
    });
  });
}

async function stopChildProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;

    const finalize = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };

    child.once("close", finalize);
    child.kill("SIGTERM");

    setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        finalize();
      }
    }, 5000);
  });
}

function startLongRunningCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachStreamLogger(child.stdout, (line) => {
    options.onStdoutLine?.(line);
  });

  attachStreamLogger(child.stderr, (line) => {
    options.onStderrLine?.(line);
  });

  return child;
}

async function ensureToolBuilt(
  buildCwd: string,
  distEntryAbs: string,
  log: (line: string) => void,
): Promise<void> {
  if (await exists(distEntryAbs)) {
    return;
  }

  log(`Tool not built yet: ${distEntryAbs}`);
  log(`Running npm run build in ${buildCwd}`);

  await runCommandStreaming(getBin("npm"), ["run", "build"], {
    cwd: buildCwd,
    onStdoutLine: (line) => log(`[build] ${line}`),
    onStderrLine: (line) => log(`[build] ${line}`),
  });

  if (!(await exists(distEntryAbs))) {
    throw new Error(
      `Expected built tool at ${distEntryAbs}, but it still does not exist`,
    );
  }
}

async function removeOutDir(outDir: string, log: (line: string) => void) {
  if (await exists(outDir)) {
    log(`Removing old output folder: ${outDir}`);
    await fs.rm(outDir, {
      recursive: true,
      force: true,
    });
  }
}

async function runCloner(
  opts: ResolvedOptions,
  log: (line: string) => void,
): Promise<void> {
  const args = [
    opts.clonerCli,
    "generate",
    "--project-root",
    opts.projectRoot,
    "--base-file",
    opts.baseFile,
    "--target-component",
    opts.targetComponent,
    "--out",
    opts.out,
    "--framework",
    opts.framework,
    "--ignore",
    opts.ignoreList.join(","),
    "--base-mode",
    "overwrite-shell",
    "--mirror-all",
  ];

  log("Starting clone generation...");

  await runCommandStreaming(getBin("node"), args, {
    onStdoutLine: (line) => log(`[cloner] ${line}`),
    onStderrLine: (line) => log(`[cloner] ${line}`),
  });

  log("Clone generation completed.");
}

async function installDependencies(
  opts: ResolvedOptions,
  log: (line: string) => void,
): Promise<void> {
  const manager = opts.packageManager;

  const installArgs =
    manager === "yarn" ? ["install"] : manager === "pnpm" ? ["install"] : ["install"];

  log(`Installing dependencies in cloned output with ${manager}...`);

  await runCommandStreaming(getBin(manager), installArgs, {
    cwd: opts.out,
    onStdoutLine: (line) => log(`[install] ${line}`),
    onStderrLine: (line) => log(`[install] ${line}`),
  });

  log("Dependency installation completed.");
}

async function runTreeTool(
  opts: ResolvedOptions,
  log: (line: string) => void,
): Promise<ParsedTree> {
  const treeIgnoreList = deriveTreeIgnoreList(opts.baseFile, opts.ignoreList);

  const args = [opts.treeCli, opts.baseFileAbs];

  if (treeIgnoreList.length > 0) {
    args.push("--ignore", treeIgnoreList.join(","));
  }

  log("Running react-tree...");

  const { stdout } = await runCommandStreaming(getBin("node"), args, {
    onStderrLine: (line) => log(`[tree] ${line}`),
  });

  const parsed = parseTreeOutput(stdout);

  log(
    `react-tree completed. Parsed ${parsed.lines.length} lines, ` +
      `${parsed.selectableCount} selectable file nodes.`,
  );

  return parsed;
}

async function startExpoWeb(
  opts: ResolvedOptions,
  log: (line: string) => void,
): Promise<{ child: ChildProcess; port: number }> {
  if (opts.framework !== "expo-router") {
    throw new Error(
      `Unsupported framework "${opts.framework}". ` +
        `This implementation currently supports only expo-router.`,
    );
  }

  const availablePort = await detectPort(opts.port);

  if (availablePort !== opts.port) {
    log(`Requested port ${opts.port} is busy. Using ${availablePort} instead.`);
  }

  const args = [
    "expo",
    "start",
    "--web",
    "--port",
    String(availablePort),
    "--non-interactive",
  ];

  log(`Starting Expo web on port ${availablePort}...`);

  const child = startLongRunningCommand(getBin("npx"), args, {
    cwd: opts.out,
    env: {
      CI: "1",
      BROWSER: "none",
      EXPO_NO_TELEMETRY: "1",
    },
    onStdoutLine: (line) => log(`[expo] ${line}`),
    onStderrLine: (line) => log(`[expo] ${line}`),
  });

  return {
    child,
    port: availablePort,
  };
}

class PreviewSwitcherApp {
  private readonly opts: ResolvedOptions;

  private screen: blessed.Widgets.Screen;
  private treeList: blessed.Widgets.ListElement;
  private logBox: blessed.Widgets.Log;
  private statusBox: blessed.Widgets.BoxElement;
  private helpBox: blessed.Widgets.BoxElement;

  private treeLines: TreeLine[] = [];
  private expoChild: ChildProcess | null = null;
  private watcher: FSWatcher | null = null;

  private regenerating = false;
  private pendingRegenerate = false;
  private shuttingDown = false;

  private selectedMirroredRelative: string | null = null;
  private selectedComponentName: string | null = null;
  private currentPort: number | null = null;
  private selectedIndex: number = 0;
  private logHistory: string[] = [];
  private diagnosticTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void>;
  private shutdownResolver: (() => void) | null = null;

  constructor(opts: ResolvedOptions) {
    this.opts = opts;

    this.selectedMirroredRelative = normalizeSlashes(opts.targetComponent);
    this.selectedComponentName = basenameWithoutExtension(opts.targetComponent);

    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      dockBorders: true,
      mouse: true,
      title: "React Preview Switcher",
    });

    this.statusBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: false,
      border: "line",
      label: " Status ",
      content: "Starting...",
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: {
          fg: "cyan",
        },
      },
    });

    this.treeList = blessed.list({
      parent: this.screen,
      top: 4,
      left: 0,
      width: "58%",
      bottom: 3,
      keys: false,
      vi: false,
      mouse: true,
      tags: false,
      border: "line",
      label: " JSX Tree Files ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        style: {
          inverse: true,
        },
      },
      style: {
        border: {
          fg: "green",
        },
        selected: {
          bg: "blue",
          fg: "white",
          bold: true,
        },
        item: {
          fg: "white",
        },
      },
      items: ["Loading tree..."],
    });

    this.logBox = blessed.log({
      parent: this.screen,
      top: 4,
      left: "58%",
      width: "42%",
      bottom: 3,
      tags: false,
      border: "line",
      label: " Logs ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        style: {
          inverse: true,
        },
      },
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: {
          fg: "yellow",
        },
      },
    });

    this.helpBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      label: " Help ",
      padding: {
        left: 1,
        right: 1,
      },
      content:
        "↑/↓ or j/k: move between files | Enter/o: open selected file | r: rebuild | q: quit | mouse wheel: scroll | click: select",
      style: {
        border: {
          fg: "magenta",
        },
      },
    });

    this.registerUiEvents();
    this.refreshStatus();
    this.screen.render();

    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolver = resolve;
    });
  }

  private registerUiEvents(): void {
    this.screen.key(["q", "C-c"], async () => {
      await this.shutdown();
    });

    this.screen.key(["up", "k"], () => {
      this.moveSelection(-1);
    });

    this.screen.key(["down", "j"], () => {
      this.moveSelection(1);
    });

    this.screen.key(["enter", "o"], async () => {
      await this.openCurrentSelection();
    });

    this.screen.key(["r"], async () => {
      await this.regenerate("manual rebuild");
    });

    this.treeList.on("click", async (_data) => {
      this.selectIndex(this.selectedIndex);
    });

    this.treeList.on("select item", () => {
      this.refreshStatus();
    });

    this.screen.on("resize", () => {
      this.screen.render();
    });

    this.treeList.focus();
  }

  private log(line: string): void {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour12: false,
    });
    const entry = `[${timestamp}] ${line}`;
    this.logHistory.push(entry);
    if (this.logHistory.length > 1000) {
      this.logHistory.shift();
    }
    this.logBox.log(entry);
    this.screen.render();
  }

  private dumpLogHistoryToConsole(): void {
    if (this.logHistory.length === 0) {
      return;
    }

    console.log("\n=== React Preview Switcher Logs (diagnostic) ===");
    this.logHistory.forEach((entry) => console.log(entry));
    console.log("=== End Logs ===\n");
  }

  private refreshStatus(extra?: string): void {
    const currentLine = this.getCurrentTreeLine();
    const selectedLabel =
      currentLine?.selectable && currentLine.componentName
        ? currentLine.componentName
        : "none";

    const lines = [
      `Project: ${this.opts.projectRoot}`,
      `Out: ${this.opts.out}`,
      `Selected tree file: ${selectedLabel}`,
      `Current PreviewRoot target: ${this.selectedMirroredRelative ?? "unknown"}`,
      `Expo web: ${
        this.currentPort ? `http://localhost:${this.currentPort}` : "not running"
      }${this.regenerating ? " | rebuilding..." : ""}${
        extra ? ` | ${extra}` : ""
      }`,
    ];

    this.statusBox.setContent(lines.join("\n"));
    this.screen.render();
  }

  private getCurrentTreeLine(): TreeLine | null {
    const index = this.selectedIndex;
    return this.treeLines[index] ?? null;
  }

  private getSelectableIndexes(): number[] {
    const output: number[] = [];

    for (let i = 0; i < this.treeLines.length; i += 1) {
      if (this.treeLines[i]?.selectable) {
        output.push(i);
      }
    }

    return output;
  }

  private selectIndex(index: number): void {
    if (index < 0 || index >= this.treeLines.length) {
      return;
    }

    this.selectedIndex = index;
    this.treeList.select(index);
    this.treeList.scrollTo(index);
    this.refreshStatus();
    this.screen.render();
  }

  private selectFirstSelectable(): void {
    const indexes = this.getSelectableIndexes();
    if (indexes.length > 0) {
      this.selectIndex(indexes[0]);
    }
  }

  private moveSelection(delta: number): void {
    if (this.treeLines.length === 0) {
      return;
    }

    const selectableIndexes = this.getSelectableIndexes();
    if (selectableIndexes.length === 0) {
      return;
    }

    const current = this.selectedIndex;
    let currentSelectablePosition = selectableIndexes.findIndex(
      (index) => index === current,
    );

    if (currentSelectablePosition === -1) {
      currentSelectablePosition = 0;
    }

    let nextPosition = currentSelectablePosition + delta;

    if (nextPosition < 0) {
      nextPosition = 0;
    }

    if (nextPosition >= selectableIndexes.length) {
      nextPosition = selectableIndexes.length - 1;
    }

    const nextIndex = selectableIndexes[nextPosition];
    if (typeof nextIndex === "number") {
      this.selectIndex(nextIndex);
    }
  }

  private renderTree(parsed: ParsedTree): void {
    this.treeLines = parsed.lines;
    this.treeList.setItems(parsed.lines.map(prefixTreeLine));
    this.selectFirstSelectable();
    this.refreshStatus(
      `tree loaded (${parsed.selectableCount} selectable file nodes)`,
    );
    this.screen.render();
  }

  private async patchToMirroredRelative(
    mirroredRelativePath: string,
  ): Promise<void> {
    const mirroredAbs = path.join(
      this.opts.out,
      ".visual-clone",
      "mirrored",
      mirroredRelativePath,
    );

    const importPath = computeImportPathFromClonedBaseToMirrored(
      this.opts.clonedBaseFileAbs,
      mirroredAbs,
    );

    await patchPreviewRootImport(this.opts.clonedBaseFileAbs, importPath);

    this.selectedMirroredRelative = normalizeSlashes(mirroredRelativePath);
    this.selectedComponentName = basenameWithoutExtension(mirroredRelativePath);

    this.log(
      `Updated PreviewRoot import in ${this.opts.baseFile} -> ${importPath}`,
    );
    this.refreshStatus("PreviewRoot updated");
  }

  private async showMatchChooser(
    componentName: string,
    matches: string[],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const outer = blessed.box({
        parent: this.screen,
        top: "center",
        left: "center",
        width: "80%",
        height: "70%",
        border: "line",
        label: ` Select mirrored file for ${componentName} `,
        style: {
          border: {
            fg: "cyan",
          },
          bg: "black",
        },
      });

      const info = blessed.box({
        parent: outer,
        top: 0,
        left: 1,
        right: 1,
        height: 2,
        content:
          "Multiple mirrored files match this component name. Choose one and press Enter. Esc cancels.",
      });

      const list = blessed.list({
        parent: outer,
        top: 2,
        left: 0,
        right: 0,
        bottom: 0,
        keys: true,
        vi: true,
        mouse: true,
        border: "line",
        scrollable: true,
        alwaysScroll: true,
        style: {
          selected: {
            bg: "blue",
            fg: "white",
          },
        },
        items: matches,
      });

      const cleanup = (value: string | null) => {
        outer.destroy();
        this.treeList.focus();
        this.screen.render();
        resolve(value);
      };

      let chosenIndex = 0;
      list.key(["enter"], () => {
        cleanup(matches[chosenIndex] ?? null);
      });

      list.key(["escape", "q"], () => {
        cleanup(null);
      });

      outer.key(["escape", "q"], () => {
        cleanup(null);
      });

      list.focus();
      list.select(0);
      this.screen.render();
    });
  }

  private async openCurrentSelection(): Promise<void> {
    const line = this.getCurrentTreeLine();

    if (!line || !line.selectable || !line.componentName) {
      this.log("Current line is not a selectable file node.");
      this.refreshStatus("line is not selectable");
      return;
    }

    this.log(`Selected component from tree: ${line.componentName}`);

    const matches = await findMirroredMatchesByComponentName(
      this.opts.out,
      line.componentName,
    );

    if (matches.length === 0) {
      this.log(
        `No mirrored file found for component "${line.componentName}". ` +
          `Expected it under .visual-clone/mirrored.`,
      );
      this.refreshStatus("no mirrored match found");
      return;
    }

    let chosen: string | null = null;

    if (matches.length === 1) {
      chosen = matches[0] ?? null;
    } else {
      this.log(
        `Found ${matches.length} mirrored matches for "${line.componentName}".`,
      );
      chosen = await this.showMatchChooser(line.componentName, matches);
    }

    if (!chosen) {
      this.log("Selection cancelled.");
      this.refreshStatus("selection cancelled");
      return;
    }

    await this.patchToMirroredRelative(chosen);
  }

  private async restorePreviousSelectionIfPossible(): Promise<void> {
    if (this.selectedMirroredRelative) {
      const exact = path.join(
        this.opts.out,
        ".visual-clone",
        "mirrored",
        this.selectedMirroredRelative,
      );

      if (await exists(exact)) {
        await this.patchToMirroredRelative(this.selectedMirroredRelative);
        return;
      }
    }

    if (this.selectedComponentName) {
      const matches = await findMirroredMatchesByComponentName(
        this.opts.out,
        this.selectedComponentName,
      );

      if (matches.length > 0) {
        await this.patchToMirroredRelative(matches[0]!);
        return;
      }
    }

    const fallback = normalizeSlashes(this.opts.targetComponent);
    const fallbackAbs = path.join(
      this.opts.out,
      ".visual-clone",
      "mirrored",
      fallback,
    );

    if (await exists(fallbackAbs)) {
      await this.patchToMirroredRelative(fallback);
    }
  }

  private selectTreeLineByComponentName(componentName: string): void {
    const index = this.treeLines.findIndex(
      (line) => line.selectable && line.componentName === componentName,
    );

    if (index >= 0) {
      this.selectIndex(index);
    }
  }

  private async regenerate(reason: string): Promise<void> {
    if (this.regenerating) {
      this.pendingRegenerate = true;
      this.log(`Rebuild already running. Queued another rebuild (${reason}).`);
      return;
    }

    this.regenerating = true;
    this.refreshStatus(`starting rebuild: ${reason}`);
    this.log(`=== Rebuild started: ${reason} ===`);

    try {
      await stopChildProcess(this.expoChild);
      this.expoChild = null;
      this.currentPort = null;

      await removeOutDir(this.opts.out, (line) => this.log(line));
      await runCloner(this.opts, (line) => this.log(line));
      await installDependencies(this.opts, (line) => this.log(line));

      const expo = await startExpoWeb(this.opts, (line) => this.log(line));
      this.expoChild = expo.child;
      this.currentPort = expo.port;

      await delay(1500);

      const parsedTree = await runTreeTool(this.opts, (line) => this.log(line));
      this.renderTree(parsedTree);

      await this.restorePreviousSelectionIfPossible();

      if (this.selectedComponentName) {
        this.selectTreeLineByComponentName(this.selectedComponentName);
      }

      this.log(
        `Preview available at http://localhost:${this.currentPort ?? this.opts.port}`,
      );
      this.refreshStatus("ready");
      this.log(`=== Rebuild finished: ${reason} ===`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      this.log(`Rebuild failed: ${message}`);
      this.refreshStatus("rebuild failed");
    } finally {
      this.regenerating = false;

      if (this.pendingRegenerate) {
        this.pendingRegenerate = false;
        await this.regenerate("queued rebuild");
      }
    }
  }

  private watchTimer: NodeJS.Timeout | null = null;

  private scheduleRegenerate(reason: string): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }

    this.watchTimer = setTimeout(async () => {
      await this.regenerate(reason);
    }, this.opts.watchDebounceMs);
  }

  private startWatcher(): void {
    if (!this.opts.watch || this.watcher) {
      return;
    }

    this.log(`Starting watcher on ${this.opts.watchDirAbs}`);

    this.watcher = chokidar.watch(this.opts.watchDirAbs, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      ignored: [
        /(^|[/\\])\../,
        /node_modules/,
        /dist/,
        /\.expo/,
      ],
    });

    this.watcher.on("all", (eventName, changedPath) => {
      this.log(`Watch event: ${eventName} ${changedPath}`);
      this.scheduleRegenerate(`watch change: ${eventName}`);
    });

    this.watcher.on("error", (error) => {
      this.log(`Watcher error: ${String(error)}`);
    });
  }

  async run(): Promise<void> {
    this.log("Ensuring sibling tools are built...");

    await ensureToolBuilt(
      this.opts.treeBuildCwd,
      this.opts.treeCli,
      (line) => this.log(line),
    );

    await ensureToolBuilt(
      this.opts.clonerBuildCwd,
      this.opts.clonerCli,
      (line) => this.log(line),
    );

    if (this.opts.watch) {
      this.startWatcher();
    }

    await this.regenerate("initial startup");
    this.startDiagnosticTimer();

    await this.shutdownPromise;
  }

  private startDiagnosticTimer(): void {
    if (!this.opts.diagnosticSeconds || this.opts.diagnosticSeconds <= 0) {
      return;
    }

    if (this.diagnosticTimer) {
      return;
    }

    this.log(
      `Diagnostic mode enabled. Auto exit after ${this.opts.diagnosticSeconds}s`,
    );

    this.diagnosticTimer = setTimeout(() => {
      void this.handleDiagnosticTimeout();
    }, this.opts.diagnosticSeconds * 1000);
  }

  private async handleDiagnosticTimeout(): Promise<void> {
    this.log("Diagnostic timer elapsed. Dumping logs and shutting down...");
    this.dumpLogHistoryToConsole();
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    this.log("Shutting down...");

    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }

    if (this.diagnosticTimer) {
      clearTimeout(this.diagnosticTimer);
      this.diagnosticTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    await stopChildProcess(this.expoChild);
    this.expoChild = null;

    this.screen.destroy();

    if (this.shutdownResolver) {
      this.shutdownResolver();
      this.shutdownResolver = null;
    }

    process.exit(0);
  }
}

function resolveOptions(raw: RawCliOptions): ResolvedOptions {
  const toolRoot = path.resolve(__dirname, "..");
  const reactMakerRoot = path.resolve(toolRoot, "..");

  const projectRoot = path.resolve(raw.projectRoot);
  const out = path.resolve(raw.out);
  const baseFile = normalizeSlashes(raw.baseFile);
  const targetComponent = normalizeSlashes(raw.targetComponent);

  const baseFileAbs = path.resolve(projectRoot, baseFile);
  const clonedBaseFileAbs = path.resolve(out, baseFile);

  const baseTopDir = normalizeSlashes(baseFile).split("/")[0] || "app";
  const watchDirAbs = path.resolve(projectRoot, baseTopDir);

  const treeCli = raw.treeCli
    ? path.resolve(raw.treeCli)
    : path.resolve(reactMakerRoot, "react-tree", "React Tree", "dist", "cli.js");

  const clonerCli = raw.clonerCli
    ? path.resolve(raw.clonerCli)
    : path.resolve(
        reactMakerRoot,
        "React-compont-visualizer",
        "react-cloner",
        "dist",
        "cli-final.js",
      );

  const treeBuildCwd = path.dirname(path.dirname(treeCli));
  const clonerBuildCwd = path.dirname(path.dirname(clonerCli));

  return {
    projectRoot,
    baseFile,
    targetComponent,
    out,
    framework: raw.framework,
    ignoreList: splitIgnoreList(raw.ignore ?? ""),
    watch: Boolean(raw.watch),
    port: raw.port ? Number(raw.port) : 19006,
    packageManager: raw.packageManager ?? "npm",
    watchDebounceMs: raw.watchDebounceMs
      ? Number(raw.watchDebounceMs)
      : 1200,
    treeCli,
    clonerCli,
    treeBuildCwd,
    clonerBuildCwd,
    baseFileAbs,
    clonedBaseFileAbs,
    watchDirAbs,
    diagnosticSeconds: raw.diagnosticSeconds
      ? Number(raw.diagnosticSeconds)
      : null,
  };
}

async function validateOptions(opts: ResolvedOptions): Promise<void> {
  if (!(await exists(opts.projectRoot))) {
    throw new Error(`Project root does not exist: ${opts.projectRoot}`);
  }

  if (!(await exists(opts.baseFileAbs))) {
    throw new Error(`Base file does not exist: ${opts.baseFileAbs}`);
  }

  const targetAbs = path.resolve(opts.projectRoot, opts.targetComponent);
  if (!(await exists(targetAbs))) {
    throw new Error(`Target component does not exist: ${targetAbs}`);
  }

  if (opts.framework !== "expo-router") {
    throw new Error(
      `Only --framework expo-router is implemented in this version.`,
    );
  }

  if (Number.isNaN(opts.port) || opts.port <= 0) {
    throw new Error(`Invalid port: ${opts.port}`);
  }

  if (Number.isNaN(opts.watchDebounceMs) || opts.watchDebounceMs < 0) {
    throw new Error(
      `Invalid watch debounce ms: ${opts.watchDebounceMs}`,
    );
  }

  if (
    opts.diagnosticSeconds !== null &&
    (Number.isNaN(opts.diagnosticSeconds) || opts.diagnosticSeconds < 0)
  ) {
    throw new Error(
      `Invalid diagnostic seconds: ${opts.diagnosticSeconds}`,
    );
  }
}

async function runConsoleMode(opts: ResolvedOptions): Promise<void> {
  console.log("🚀 Starting React Preview Switcher in console mode...");
  console.log(`📁 Project: ${opts.projectRoot}`);
  console.log(`📄 Base file: ${opts.baseFile}`);
  console.log(`🎯 Target: ${opts.targetComponent}`);
  console.log(`📦 Output: ${opts.out}`);
  console.log();

  const logHistory: string[] = [];
  const pushLog = (line: string) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
    logHistory.push(entry);
    if (logHistory.length > 1000) {
      logHistory.shift();
    }
    console.log(entry);
  };

  const dumpLogHistory = () => {
    if (logHistory.length === 0) {
      return;
    }

    console.log("\n=== React Preview Switcher Logs (diagnostic) ===");
    logHistory.forEach((entry) => console.log(entry));
    console.log("=== End Logs ===\n");
  };

  try {
    pushLog("Ensuring sibling tools are built...");

    await ensureToolBuilt(
      opts.treeBuildCwd,
      opts.treeCli,
      (line) => pushLog(`[build] ${line}`),
    );

    await ensureToolBuilt(
      opts.clonerBuildCwd,
      opts.clonerCli,
      (line) => pushLog(`[build] ${line}`),
    );

    pushLog("Building initial clone...");
    
    await removeOutDir(opts.out, (line) => pushLog(line));
    await runCloner(opts, (line) => pushLog(line));
    await installDependencies(opts, (line) => pushLog(line));

    const expo = await startExpoWeb(opts, (line) => pushLog(line));
    pushLog(`✅ Expo web started on port ${expo.port}`);
    pushLog(`🌐 Preview available at http://localhost:${expo.port}`);

    await delay(2000);

    const parsedTree = await runTreeTool(opts, (line) => pushLog(line));
    pushLog(`🌳 Found ${parsedTree.selectableCount} selectable components:`);
    
    const selectableLines = parsedTree.lines.filter(line => line.selectable);
    selectableLines.forEach((line, index) => {
      console.log(`  ${index + 1}. ${line.componentName}`);
    });

    pushLog(`🎯 Current preview: ${opts.targetComponent}`);
    pushLog(
      `💡 To switch previews, edit ${path.join(opts.out, opts.baseFile)} and change the PreviewRoot import.`,
    );
    pushLog(
      `📂 Mirrored files available in: ${path.join(
        opts.out,
        ".visual-clone",
        "mirrored",
      )}`,
    );

    let watcher: FSWatcher | null = null;
    let diagTimer: NodeJS.Timeout | null = null;

    const cleanup = async () => {
      if (diagTimer) {
        clearTimeout(diagTimer);
        diagTimer = null;
      }

      if (watcher) {
        await watcher.close();
        watcher = null;
      }

      await stopChildProcess(expo.child);
    };

    const exitWithLogs = async (code = 0) => {
      pushLog("Diagnostic cleanup in progress...");
      await cleanup();
      dumpLogHistory();
      process.exit(code);
    };

    if (opts.watch) {
      pushLog(`👀 Watching for changes in ${opts.watchDirAbs}...`);
      
      watcher = chokidar.watch(opts.watchDirAbs, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
        ignored: [
          /(^|[/\\])\../,
          /node_modules/,
          /dist/,
          /\.expo/,
        ],
      });

      let rebuildTimer: NodeJS.Timeout | null = null;
      
      watcher.on("all", (eventName, changedPath) => {
        pushLog(`📝 Watch event: ${eventName} ${changedPath}`);
        
        if (rebuildTimer) {
          clearTimeout(rebuildTimer);
        }
        
        rebuildTimer = setTimeout(async () => {
          try {
            pushLog("🔄 Rebuilding...");
            await stopChildProcess(expo.child);
            
            await removeOutDir(opts.out, (line) => pushLog(line));
            await runCloner(opts, (line) => pushLog(line));
            await installDependencies(opts, (line) => pushLog(line));
            
            const newExpo = await startExpoWeb(opts, (line) => pushLog(line));
            expo.child = newExpo.child;
            expo.port = newExpo.port;
            
            pushLog(`✅ Rebuild complete! Expo web on port ${expo.port}`);
          } catch (error) {
            pushLog(
              `❌ Rebuild failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }, opts.watchDebounceMs);
      });

      watcher.on("error", (error) => {
        pushLog(`❌ Watcher error: ${String(error)}`);
      });

      pushLog("✨ Console mode is running! Press Ctrl+C to stop.");

      if (opts.diagnosticSeconds && opts.diagnosticSeconds > 0) {
        diagTimer = setTimeout(() => {
          pushLog(
            `Diagnostic timer of ${opts.diagnosticSeconds}s elapsed. Exiting...`,
          );
          void exitWithLogs(0);
        }, opts.diagnosticSeconds * 1000);
      }

      process.on("SIGINT", async () => {
        pushLog("🛑 Shutting down (SIGINT)...");
        await exitWithLogs(0);
      });

      await new Promise(() => {});
    } else {
      pushLog("✨ Console mode complete! Expo is running in the background.");
      pushLog("💡 Press Ctrl+C to stop the Expo server.");

      if (opts.diagnosticSeconds && opts.diagnosticSeconds > 0) {
        diagTimer = setTimeout(() => {
          pushLog(
            `Diagnostic timer of ${opts.diagnosticSeconds}s elapsed. Exiting...`,
          );
          void exitWithLogs(0);
        }, opts.diagnosticSeconds * 1000);
      }

      process.on("SIGINT", async () => {
        pushLog("🛑 Shutting down (SIGINT)...");
        await exitWithLogs(0);
      });

      await new Promise(() => {});
    }
  } catch (error) {
    pushLog(
      `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    dumpLogHistory();
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("react-preview-switcher")
    .description(
      "Wrapper around react-tree and react-cloner to create a live selectable preview switcher.",
    )
    .requiredOption("--project-root <path>")
    .requiredOption("--base-file <path>")
    .requiredOption("--target-component <path>")
    .requiredOption("--out <path>")
    .option("--framework <name>", "Framework type", "expo-router")
    .option("--ignore <csv>", "Comma-separated ignored paths", "")
    .option("--watch", "Watch source files and fully rebuild on changes", false)
    .option("--port <number>", "Preferred Expo web port", "19006")
    .option(
      "--package-manager <name>",
      "Package manager for cloned app install",
      "npm",
    )
    .option(
      "--watch-debounce-ms <number>",
      "Debounce delay before rebuild after file changes",
      "1200",
    )
    .option(
      "--tree-cli <path>",
      "Optional override path to react-tree dist/cli.js",
    )
    .option(
      "--cloner-cli <path>",
      "Optional override path to react-cloner dist/cli-final.js",
    )
    .option(
      "--diagnostic-seconds <number>",
      "Automatically exit after N seconds and dump logs",
    )
    .option("--no-ui", "Run in console mode without interactive TUI", false);

  program.parse(process.argv);

  const raw = program.opts<RawCliOptions & { noUi?: boolean }>();
  const opts = resolveOptions(raw);

  await validateOptions(opts);

  if (raw.noUi) {
    await runConsoleMode(opts);
  } else {
    try {
      const app = new PreviewSwitcherApp(opts);
      await app.run();
    } catch (error) {
      console.error("Failed to start interactive UI. Falling back to console mode.");
      console.error("UI Error:", error instanceof Error ? error.message : String(error));
      console.log("\nRunning in console mode...\n");
      await runConsoleMode(opts);
    }
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
