export function runCommand(
  command: string[],
  options: {
    cwd?: string
    allowFailure?: boolean
    errorPrefix?: string
  } = {},
) {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    stderr: "pipe",
    stdout: "pipe",
  })

  if (result.exitCode !== 0 && !options.allowFailure) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    throw new Error(
      [
        options.errorPrefix ?? `Command failed: ${command.join(" ")}`,
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }

  return result
}
