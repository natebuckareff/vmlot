import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import prettyBytes from "pretty-bytes";
import prettyMilliseconds from "pretty-ms";
import type { Api } from "./api";
import { ApiClient } from "./api-client";
import { HttpServer } from "./http-server";
import { formatCliId } from "./id";
import type { ImageInfo } from "./image";
import { ServerRegistry, type ServerRegistryEntry } from "./server-registry";
import { TablePrinter } from "./table-printer";
import { DEFAULT_VM_USER, type VmInfo } from "./vm";

const DEFAULT_DATA_DIR = "data";
const DEFAULT_SERVER_PORT = 10450;
const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const DEFAULT_VM_MEMORY = 2048;
const DEFAULT_VM_VCPU = 2;

async function main() {
  const [resource, ...args] = Bun.argv.slice(2);

  if (resource === "run") {
    const flags = parseFlags(args);
    const server = await HttpServer.create({
      dataDir: resolve(flags.get("--data-dir") ?? DEFAULT_DATA_DIR),
      hostname: flags.get("--host"),
      port: flags.has("--port")
        ? Number.parseInt(required(flags, "--port"), 10)
        : undefined,
    });
    await server.listen();
    return;
  }

  const [action, ...rest] = args;
  const flags = parseFlags(rest);

  if (flags.has("--data-dir")) {
    throw new Error(`--data-dir is only supported by vmlot run`);
  }

  if (resource === "servers" && action === "list") {
    const servers = await new ServerRegistry().list();
    console.log(formatServerTable(servers));
    return;
  }

  if (resource === "servers" && action === "add") {
    const name = required(flags, "--name");
    const host = required(flags, "--host");
    const port = flags.has("--port")
      ? parseIntegerFlag(flags, "--port")
      : DEFAULT_SERVER_PORT;
    await new ServerRegistry().add(name, { host, port });
    console.log(`added ${name}`);
    return;
  }

  if (resource === "servers" && action === "remove") {
    const name = required(flags, "--name");
    await new ServerRegistry().remove(name);
    console.log(`removed ${name}`);
    return;
  }

  const api = await createApi(flags);

  if (resource === "images" && action === "list") {
    const images = await api.listImages();
    console.log(formatImageTable(images));
    return;
  }

  if (resource === "images" && action === "create") {
    const name = required(flags, "--name");
    const url = required(flags, "--url");
    const image = await api.createImage({ name, url });
    console.log(formatCliId(image.id));
    return;
  }

  if (resource === "images" && action === "remove") {
    const id = required(flags, "--id");
    await api.removeImage(id);
    console.log(`removed ${formatCliId(id)}`);
    return;
  }

  if (resource === "vms" && action === "list") {
    const vms = await api.listVms();
    console.log(formatVmTable(vms));
    return;
  }

  if (resource === "vms" && action === "create") {
    const vm = await api.createVm({
      name: required(flags, "--name"),
      baseImageId: required(flags, "--base-image"),
      user: flags.get("--user"),
      sshPublicKey: await resolveValue(required(flags, "--ssh-public-key")),
      memory: flags.has("--memory")
        ? parseIntegerFlag(flags, "--memory")
        : DEFAULT_VM_MEMORY,
      vcpu: flags.has("--vcpu")
        ? parseIntegerFlag(flags, "--vcpu")
        : DEFAULT_VM_VCPU,
    });
    console.log(`${formatCliId(vm.id)} ${vm.status} ${vm.name}`);
    return;
  }

  if (resource === "vms" && action === "remove") {
    const id = required(flags, "--id");
    await api.removeVm(id);
    console.log(`removed ${formatCliId(id)}`);
    return;
  }

  if (resource === "vms" && action === "start") {
    const id = required(flags, "--id");
    await api.startVm(id);
    console.log(`started ${formatCliId(id)}`);
    return;
  }

  if (resource === "vms" && action === "stop") {
    const id = required(flags, "--id");
    await api.stopVm(id);
    console.log(`stopped ${formatCliId(id)}`);
    return;
  }

  throw new Error(usage());
}

function parseFlags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [parsedFlag, inlineValue] = arg.split("=", 2);
    const flag = parsedFlag ?? arg;
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }

    values.set(flag, value);
  }

  return values;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) {
    throw new Error(`Missing required ${name}\n\n${usage()}`);
  }
  return value;
}

function usage(): string {
  return [
    `Usage:`,
    `  vmlot run [--data-dir ./data] [--host 0.0.0.0] [--port ${DEFAULT_SERVER_PORT}]`,
    `  vmlot servers list`,
    `  vmlot servers add --name lab --host 10.0.0.50 [--port ${DEFAULT_SERVER_PORT}]`,
    `  vmlot servers remove --name lab`,
    `  vmlot images list [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot images create --name debian-13 --url https://... [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot images remove --id <image-id> [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot vms list [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot vms create --name vm01 --base-image debian-13 [--user ${DEFAULT_VM_USER}] --ssh-public-key ~/.ssh/id_ed25519.pub [--memory 2048] [--vcpu 2] [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot vms start --id <vm-id> [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot vms stop --id <vm-id> [--server lab|${DEFAULT_SERVER_URL}]`,
    `  vmlot vms remove --id <vm-id> [--server lab|${DEFAULT_SERVER_URL}]`,
  ].join("\n");
}

async function createApi(flags: Map<string, string>): Promise<Api> {
  const server = flags.get("--server");
  if (!server) {
    return new ApiClient(DEFAULT_SERVER_URL);
  }

  return new ApiClient(await new ServerRegistry().resolve(server));
}

function formatServerTable(servers: ServerRegistryEntry[]): string {
  const table = new TablePrinter(["NAME", "HOST", "PORT"], {
    columnSpacing: 3,
  });

  for (const server of servers) {
    table.addRow([server.name, server.endpoint.host, server.endpoint.port]);
  }

  return table.render();
}

function formatImageTable(images: ImageInfo[]): string {
  const includeProgress = images.some(
    (image) => image.status === "downloading",
  );
  const headers = includeProgress
    ? ["ID", "HASH", "NAME", "STATUS", "CREATED", "SIZE", "PROGRESS", "SOURCE"]
    : ["ID", "HASH", "NAME", "STATUS", "CREATED", "SIZE", "SOURCE"];
  const table = new TablePrinter(headers, { columnSpacing: 3 });

  for (const image of images) {
    const row = [
      formatCliId(image.id),
      image.hash ? formatCliId(image.hash) : "-",
      image.name,
      image.status,
      formatCreatedAt(image.createdAt),
      formatImageSize(image.sizeBytes),
    ];

    if (includeProgress) {
      row.push(formatImageProgress(image));
    }

    row.push(sourceFileName(image.url));
    table.addRow(row);
  }

  return table.render();
}

function parseIntegerFlag(flags: Map<string, string>, name: string): number {
  const value = Number.parseInt(required(flags, name), 10);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid integer for ${name}: ${required(flags, name)}`);
  }
  return value;
}

function formatVmTable(vms: VmInfo[]): string {
  const table = new TablePrinter(
    [
      "ID",
      "NAME",
      "IMAGE",
      "STATUS",
      "CREATED",
      "VCPU",
      "MEMORY",
      "DISK USAGE",
      "ADDRESS",
    ],
    {
      columnSpacing: 3,
    },
  );

  for (const vm of vms) {
    table.addRow([
      formatCliId(vm.id),
      vm.name,
      vm.baseImageName,
      vm.status,
      formatCreatedAt(vm.createdAt),
      vm.vcpu,
      formatVmMemory(vm.memory),
      formatImageSize(vm.diskUsageBytes),
      vm.address ?? "-",
    ]);
  }

  return table.render();
}

function formatVmMemory(memoryMiB: number): string {
  return `${memoryMiB} MiB`;
}

function formatImageSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) {
    return "-";
  }

  return prettyBytes(sizeBytes);
}

function formatImageProgress(image: ImageInfo): string {
  if (image.status !== "downloading") {
    return "-";
  }

  return `${Math.round(image.progress * 100)}%`;
}

function formatCreatedAt(createdAt: number | undefined): string {
  if (createdAt === undefined) {
    return "-";
  }

  return `${prettyMilliseconds(Math.max(0, Date.now() - createdAt), { compact: true })} ago`;
}

function sourceFileName(url: string): string {
  if (!url) {
    return "-";
  }

  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? url;
  } catch {
    const segments = url.split("/").filter(Boolean);
    return segments.at(-1) ?? url;
  }
}

async function resolveValue(value: string): Promise<string> {
  const explicitPath = value.startsWith("@") ? value.slice(1) : null;
  const candidatePath = explicitPath ?? value;

  if (explicitPath || looksLikeFilePath(candidatePath)) {
    const path = resolvePath(candidatePath);
    return (await readFile(path, "utf8")).trim();
  }

  return value;
}

function resolvePath(value: string) {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }

  return resolve(value);
}

function looksLikeFilePath(value: string) {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~")
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
