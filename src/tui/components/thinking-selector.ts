/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/thinking-selector.ts
(@earendil-works/pi-coding-agent 1.1.0). Monchu has no in-session thinking cycle key, so that hint is left out.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatKeyText, keyDisplayText } from "./keybinding-hints.ts";
import { SAVE_KEY } from "./model-selector.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

const LEVEL_DESCRIPTIONS: Record<ModelThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

/** Select items carry strings; each keeps its typed level beside them. */
type LevelItem = SelectItem & { level: ModelThinkingLevel };

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
  private searchInput: Input;
  private selectList: SelectList;
  private selectListChildIndex: number;
  private allItems: LevelItem[];
  private onSelect: (level: ModelThinkingLevel) => void;
  private onCancel: () => void;
  private onSelectAsDefault: ((level: ModelThinkingLevel) => void) | undefined;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    currentLevel: ModelThinkingLevel,
    availableLevels: readonly ModelThinkingLevel[],
    onSelect: (level: ModelThinkingLevel) => void,
    onCancel: () => void,
    onSelectAsDefault?: (level: ModelThinkingLevel) => void,
    defaultThinkingLevel?: ModelThinkingLevel,
  ) {
    super();

    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.onSelectAsDefault = onSelectAsDefault;

    this.allItems = availableLevels.map((level) => ({
      value: level,
      level,
      label: `${level === currentLevel ? "✓ " : "  "}${level}`,
      description:
        level === defaultThinkingLevel
          ? `${LEVEL_DESCRIPTIONS[level]} · default`
          : LEVEL_DESCRIPTIONS[level],
    }));

    // Add top border
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new Text("Thinking Level", 0, 0));
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    // Create selector
    this.selectList = this.buildSelectList(this.allItems, currentLevel);
    this.selectListChildIndex = this.children.length;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg(
          "dim",
          `  ${keyDisplayText("tui.select.confirm")} to select · ${formatKeyText(SAVE_KEY)} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
        ),
        0,
        0,
      ),
    );

    // Add bottom border
    this.addChild(new DynamicBorder());
  }

  private level(value: string | undefined): ModelThinkingLevel | undefined {
    return this.allItems.find((item) => item.value === value)?.level;
  }

  private buildSelectList(items: LevelItem[], preselect: string | undefined): SelectList {
    const list = new SelectList(
      items,
      Math.max(1, items.length),
      getSelectListTheme(),
      THINKING_SELECT_LIST_LAYOUT,
    );
    const currentIndex = items.findIndex((item) => item.value === preselect);
    if (currentIndex !== -1) {
      list.setSelectedIndex(currentIndex);
    }
    list.onSelect = (item) => {
      const level = this.level(item.value);
      if (level !== undefined) this.onSelect(level);
    };
    list.onCancel = () => this.onCancel();
    return list;
  }

  private applyFilter(query: string): void {
    const filtered = query
      ? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
      : this.allItems;
    const selectedValue = this.selectList.getSelectedItem()?.value;
    const newList = this.buildSelectList(filtered, selectedValue);
    this.children[this.selectListChildIndex] = newList;
    this.selectList = newList;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (matchesKey(keyData, SAVE_KEY) && this.onSelectAsDefault) {
      const level = this.level(this.selectList.getSelectedItem()?.value);
      if (level !== undefined) this.onSelectAsDefault(level);
      return;
    }
    const isNav =
      kb.matches(keyData, "tui.select.up") ||
      kb.matches(keyData, "tui.select.down") ||
      kb.matches(keyData, "tui.select.confirm") ||
      kb.matches(keyData, "tui.select.cancel");
    if (isNav) {
      this.selectList.handleInput(keyData);
      return;
    }
    this.searchInput.handleInput(keyData);
    this.applyFilter(this.searchInput.getValue());
  }
}
