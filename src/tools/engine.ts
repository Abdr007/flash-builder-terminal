/**
 * Tool engine — registers `ToolDefinition`s under both their internal name
 * (e.g. `magicOpen`) and their CLI alias (`open`). Dispatches a parsed
 * command to the matching tool with a Zod-validated parameter object.
 */

import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/index.js';
import { magicTools } from './magic-tools.js';

/**
 * CLI alias map — drops the `magic` prefix and lower-cases.
 *  magicOpen → open
 *  magicAddCollateral → add-collateral
 */
function toCliAlias(name: string): string {
  const stripped = name.startsWith('magic') ? name.slice(5) : name;
  return stripped
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[A-Z]/g, (m, idx) => (idx === 0 ? m.toLowerCase() : m))
    .toLowerCase();
}

export class ToolEngine {
  private byName = new Map<string, ToolDefinition>();
  private byAlias = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = magicTools) {
    for (const t of tools) this.register(t);
  }

  register(tool: ToolDefinition): void {
    this.byName.set(tool.name, tool);
    this.byAlias.set(toCliAlias(tool.name), tool);
  }

  /** Lookup a tool by either its internal name or CLI alias. */
  get(nameOrAlias: string): ToolDefinition | undefined {
    return this.byName.get(nameOrAlias) ?? this.byAlias.get(nameOrAlias.toLowerCase());
  }

  /** All tools, sorted by alias for stable help-listing. */
  list(): { alias: string; name: string; description: string }[] {
    return [...this.byName.values()]
      .map((t) => ({ alias: toCliAlias(t.name), name: t.name, description: t.description }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
  }

  hasAlias(alias: string): boolean {
    return this.byAlias.has(alias.toLowerCase());
  }

  /**
   * Validate params with the tool's Zod schema (if any) and execute.
   * Returns `{ success: false, message }` on validation error rather than
   * throwing — keeps the REPL alive on bad user input.
   */
  async dispatch(nameOrAlias: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.get(nameOrAlias);
    if (!tool) {
      return { success: false, message: `Unknown command: ${nameOrAlias}. Type 'help' to list commands.` };
    }

    let validated: Record<string, unknown> = params;
    if (tool.parameters) {
      const result = (tool.parameters as z.ZodTypeAny).safeParse(params);
      if (!result.success) {
        const msg = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
        return { success: false, message: `Invalid parameters: ${msg}` };
      }
      validated = result.data as Record<string, unknown>;
    }

    return tool.execute(validated, context);
  }
}

let _engine: ToolEngine | null = null;

export function getEngine(): ToolEngine {
  if (!_engine) _engine = new ToolEngine();
  return _engine;
}

export function resetEngine(): void {
  _engine = null;
}
