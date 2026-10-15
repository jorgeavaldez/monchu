/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/model-selector.ts and
modes/interactive/model-search.ts (@earendil-works/pi-coding-agent 1.1.0).
Monchu has no scoped models or catalog refresh: its catalogs are code, so those parts are left out.

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
import { type Api, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  getKeybindings,
  Input,
  matchesKey,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatKeyText, keyDisplayText } from "./keybinding-hints.ts";

/** Pi's default for `app.models.save` and `app.thinking.save`. */
export const SAVE_KEY = "ctrl+s";

interface ModelItem {
  provider: string;
  id: string;
  model: Model<Api>;
}

interface DefaultModelReference {
  provider: string;
  id: string;
}

/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
function getModelSelectorSearchText(item: { id: string; provider: string; name?: string }): string {
  const { id, provider } = item;
  const name = item.name ? ` ${item.name}` : "";
  return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
  private searchInput: Input;

  // Focusable implementation - propagate to searchInput for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  private listContainer: Container;
  private allModels: ModelItem[] = [];
  private filteredModels: ModelItem[] = [];
  private selectedIndex: number = 0;
  private currentModel: Model<Api> | undefined;
  private onSelectCallback: (model: Model<Api>) => void;
  private onSelectAsDefaultCallback: ((model: Model<Api>) => void) | undefined;
  private onCancelCallback: () => void;
  private defaultModel: DefaultModelReference | undefined;

  constructor(
    currentModel: Model<Api> | undefined,
    models: readonly Model<Api>[],
    onSelect: (model: Model<Api>) => void,
    onCancel: () => void,
    initialSearchInput?: string,
    onSelectAsDefault?: (model: Model<Api>) => void,
    defaultModel?: DefaultModelReference,
  ) {
    super();

    this.currentModel = currentModel;
    this.defaultModel = defaultModel;
    this.onSelectCallback = onSelect;
    this.onSelectAsDefaultCallback = onSelectAsDefault;
    this.onCancelCallback = onCancel;

    // Add top border
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    // Add hint about model filtering
    const hintText = "Only showing models from configured providers. Use /login to add providers.";
    this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
    this.addChild(new Spacer(1));

    // Create search input
    this.searchInput = new Input();
    if (initialSearchInput) {
      this.searchInput.setValue(initialSearchInput);
    }
    this.searchInput.onSubmit = () => {
      // Enter on search input selects the first filtered item
      const selected = this.filteredModels[this.selectedIndex];
      if (selected) {
        this.handleSelect(selected.model);
      }
    };
    this.addChild(this.searchInput);

    this.addChild(new Spacer(1));

    // Create list container
    this.listContainer = new Container();
    this.addChild(this.listContainer);

    this.addChild(new Spacer(1));

    // Hint
    if (this.onSelectAsDefaultCallback) {
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
    }

    // Add bottom border
    this.addChild(new DynamicBorder());

    this.loadModels(models);
    if (initialSearchInput) this.filterModels(initialSearchInput);
    else this.updateList();
  }

  private loadModels(models: readonly Model<Api>[]): void {
    this.allModels = this.sortModels(
      models.map((model) => ({ provider: model.provider, id: model.id, model })),
    );
    this.filteredModels = this.allModels;
    const currentIndex = this.filteredModels.findIndex((item) =>
      modelsAreEqual(this.currentModel, item.model),
    );
    this.selectedIndex = Math.max(0, currentIndex);
  }

  private sortModels(models: ModelItem[]): ModelItem[] {
    const sorted = [...models];
    // Sort: current model first, default model second, then by provider.
    sorted.sort((a, b) => {
      const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
      const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      const aIsDefault = this.isDefaultModel(a.model);
      const bIsDefault = this.isDefaultModel(b.model);
      if (aIsDefault && !bIsDefault) return -1;
      if (!aIsDefault && bIsDefault) return 1;
      return a.provider.localeCompare(b.provider);
    });
    return sorted;
  }

  private isDefaultModel(model: Model<Api>): boolean {
    return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
  }

  private isDefaultSearch(query: string): boolean {
    const normalized = query.trim().toLowerCase();
    return normalized.length > 0 && "default".startsWith(normalized);
  }

  private filterModels(query: string): void {
    if (query) {
      const filtered = fuzzyFilter(this.allModels, query, (item) => {
        const defaultText = this.isDefaultModel(item.model) ? " default" : "";
        return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
      });
      if (this.isDefaultSearch(query)) {
        const defaultItems = this.allModels.filter((item) => this.isDefaultModel(item.model));
        const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
        this.filteredModels = [
          ...defaultItems,
          ...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
        ];
      } else {
        this.filteredModels = filtered;
      }
    } else {
      this.filteredModels = this.allModels;
    }
    // When filtering by a query, move the selector to the top row so the best
    // match is highlighted. When the query is cleared, keep the current position
    // clamped to the (restored) list length.
    this.selectedIndex = query
      ? 0
      : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filteredModels.length - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

    // Show visible slice of filtered models
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);
      const isDefault = this.isDefaultModel(item.model);
      const defaultBadge = isDefault ? theme.fg("muted", " · default") : "";

      const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
      const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
      const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
      const providerBadge = theme.fg("muted", `[${item.provider}]`);
      const line = `${cursor}${currentMarker}${modelText} ${providerBadge}${defaultBadge}`;

      this.listContainer.addChild(new Text(line, 0, 0));
    }

    // Add scroll indicator if needed
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      const scrollInfo = theme.fg(
        "muted",
        `  (${this.selectedIndex + 1}/${this.filteredModels.length})`,
      );
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }

    // Show "no results" if empty
    const selected = this.filteredModels[this.selectedIndex];
    if (selected === undefined) {
      this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
    } else {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0),
      );
    }
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    // Up arrow - wrap to bottom when at top
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
      this.updateList();
    }
    // Down arrow - wrap to top when at bottom
    else if (kb.matches(keyData, "tui.select.down")) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
    }
    // Enter
    else if (kb.matches(keyData, "tui.select.confirm")) {
      const selectedModel = this.filteredModels[this.selectedIndex];
      if (selectedModel) {
        this.handleSelect(selectedModel.model);
      }
    }
    // Escape or Ctrl+C
    else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancelCallback();
    }
    // Select and save as default
    else if (matchesKey(keyData, SAVE_KEY) && this.onSelectAsDefaultCallback) {
      const selectedModel = this.filteredModels[this.selectedIndex];
      if (selectedModel) {
        this.onSelectAsDefaultCallback(selectedModel.model);
      }
    }
    // Pass everything else to search input
    else {
      this.searchInput.handleInput(keyData);
      this.filterModels(this.searchInput.getValue());
    }
  }

  private handleSelect(model: Model<Api>): void {
    this.onSelectCallback(model);
  }
}
