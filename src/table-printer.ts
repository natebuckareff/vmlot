type TableValue = string | number | null | undefined

const DEFAULT_COLUMN_SPACING = 3

export class TablePrinter {
  private readonly rows: string[][] = []
  private readonly headers: string[]
  private readonly columnSpacing: number

  constructor(headers: string[], options: { columnSpacing?: number } = {}) {
    if (headers.length === 0) {
      throw new Error("TablePrinter requires at least one header")
    }

    this.headers = headers
    this.columnSpacing = options.columnSpacing ?? DEFAULT_COLUMN_SPACING
  }

  addRow(values: TableValue[]): void {
    if (values.length !== this.headers.length) {
      throw new Error(`Expected ${this.headers.length} columns, received ${values.length}`)
    }

    this.rows.push(values.map((value) => formatValue(value)))
  }

  render(): string {
    const widths = this.headers.map((header, index) =>
      Math.max(header.length, ...this.rows.map((row) => row[index].length)),
    )
    const lines = [this.headers, ...this.rows].map((row) => formatRow(row, widths, this.columnSpacing))
    return lines.join("\n")
  }
}

function formatRow(values: string[], widths: number[], columnSpacing: number): string {
  const separator = " ".repeat(columnSpacing)

  return values
    .map((value, index) => {
      if (index === values.length - 1) {
        return value
      }

      return value.padEnd(widths[index], " ")
    })
    .join(separator)
}

function formatValue(value: TableValue): string {
  if (value === null || value === undefined) {
    return ""
  }

  return String(value)
}
