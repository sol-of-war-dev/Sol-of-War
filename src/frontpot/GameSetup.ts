import {
  maps,
  GameMapSize,
  GameMode,
  type GameMapType,
  type Difficulty,
  type UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import "../client/components/GameConfigSettings";
import {
  getBotsForCompactMap,
  getNationsForCompactMap,
  nationsConfigToSlider,
  sliderToNationsConfig,
} from "../client/utilities/GameConfigHelpers";
import {
  rankedRules,
  defaultRules,
  mapNationCount,
  mapPopulation,
  type Rules,
} from "./Rules";

@customElement("frontpot-game-setup")
export class GameSetup extends LitElement {
  @property({ attribute: false }) rules: Rules = defaultRules();
  @property() mode = "ffa";
  @property({ type: Boolean }) ranked = false;
  createRenderRoot() {
    return this;
  }
  private change(patch: Partial<Rules>) {
    this.rules = this.ranked
      ? rankedRules({ ...this.rules, ...patch }, this.mode)
      : { ...this.rules, ...patch };
    this.dispatchEvent(
      new CustomEvent("rules-changed", { detail: this.rules, bubbles: true }),
    );
  }
  private number(
    key: "maxPlayers" | "maxTimerValue" | "goldMultiplier" | "startingGold",
    label: string,
    min: number,
    max: number,
    step = 1,
  ) {
    return html`<label class="fp-rule-field"
      >${label}<input
        type="number"
        min=${min}
        max=${max}
        step=${step}
        .value=${String((this.ranked ? rankedRules(this.rules, this.mode) : this.rules)[key])}
        ?disabled=${this.ranked}
        @change=${(e: Event) => this.change({ [key]: Number((e.target as HTMLInputElement).value) })}
    /></label>`;
  }
  private selectMap(map: GameMapType) {
    this.change({
      gameMap: map,
      nations: mapPopulation(map, this.rules.gameMapSize, this.mode).nations,
    });
  }
  render() {
    const r = this.ranked ? rankedRules(this.rules, this.mode) : this.rules;
    const nationDefault = mapNationCount(r.gameMap);
    const toggles: Record<string, keyof Rules> = {
      "game_settings.instant_build": "instantBuild",
      "game_settings.random_spawn": "randomSpawn",
      "host_modal.donate_gold": "donateGold",
      "host_modal.donate_troops": "donateTroops",
      "game_settings.infinite_gold": "infiniteGold",
      "game_settings.infinite_troops": "infiniteTroops",
      "game_settings.water_nukes": "waterNukes",
    };
    return html`<div class="fp-upstream-settings">
      <p class="fp-small">
        ${this.ranked ? "Ranked rules are fixed. Choose a map, random spawn or compact map. All other settings are shown for reference." : "Choose a battlefield and game rules."}
      </p>
      <game-config-settings
        .settings=${{
          map: { selected: r.gameMap, useRandom: false },
          difficulty: { selected: r.difficulty, disabled: this.ranked },
          gameMode: {
            locked: true,
            selected: this.mode === "2v2" ? GameMode.Team : GameMode.FFA,
          },
          teamCount: { locked: true, selected: 2 },
          options: {
            titleKey: "game_settings.options",
            locked: this.ranked,
            bots: {
              value: r.bots,
              labelKey: "game_settings.bots",
              disabledKey: "common.disabled",
            },
            nations: {
              value:
                typeof r.nations === "number"
                  ? r.nations
                  : r.nations === "default"
                    ? nationDefault
                    : 0,
              defaultValue: nationDefault,
              labelKey: "game_settings.nations",
              disabledKey: "common.disabled",
            },
            toggles: [
              ...Object.entries(toggles).map(([labelKey, key]) => ({
                labelKey,
                checked: r[key] === true,
                disabled: this.ranked && key !== "randomSpawn",
              })),
              {
                labelKey: "game_settings.compact_map",
                checked: r.gameMapSize === GameMapSize.Compact,
              },
              {
                labelKey: "game_settings.doomsday_clock",
                checked: r.doomsdayClock.enabled,
                disabled: this.ranked,
                doomsdayClockSpeed: r.doomsdayClock.speed,
              },
            ],
            inputCards: [
              html`<div class="fp-rule-grid">
                ${this.number("maxPlayers", "FFA player limit", 2, 100)}${this.number("maxTimerValue", "Match length (minutes)", 1, 120)}
                ${this.number("goldMultiplier", "Gold multiplier", 0.1, 1000, 0.1)}${this.number("startingGold", "Starting gold", 0, 1_000_000_000)}
                <label class="fp-checkbox"
                  ><input
                    type="checkbox"
                    ?disabled=${this.ranked}
                    .checked=${r.disableAlliances}
                    @change=${() => this.change({ disableAlliances: !r.disableAlliances })}
                  />Disable alliances</label
                >
                <label class="fp-checkbox"
                  ><input
                    type="checkbox"
                    ?disabled=${this.ranked}
                    .checked=${r.overtime.enabled}
                    @change=${() => this.change({ overtime: { ...r.overtime, enabled: !r.overtime.enabled } })}
                  />Overtime after ${r.overtime.startMinutes} minutes</label
                >
              </div>`,
            ],
          },
          unitTypes: {
            titleKey: "game_settings.disable_units",
            disabledUnits: r.disabledUnits,
            locked: this.ranked,
          },
        }}
        @random-map-selected=${() => this.selectMap(maps[crypto.getRandomValues(new Uint32Array(1))[0] % maps.length].type)}
        @map-selected=${(e: CustomEvent<{ map: GameMapType }>) => this.selectMap(e.detail.map)}
        @difficulty-selected=${(e: CustomEvent<{ difficulty: Difficulty }>) => this.change({ difficulty: e.detail.difficulty })}
        @bots-changed=${(e: CustomEvent<{ value: number }>) => this.change({ bots: e.detail.value })}
        @nations-changed=${(e: CustomEvent<{ value: number }>) => this.change({ nations: e.detail.value === 0 ? "disabled" : e.detail.value === nationDefault ? "default" : e.detail.value })}
        @unit-toggle-changed=${(e: CustomEvent<{ unit: UnitType; checked: boolean }>) => this.change({ disabledUnits: e.detail.checked ? [...r.disabledUnits, e.detail.unit] : r.disabledUnits.filter((u) => u !== e.detail.unit) })}
        @option-toggle-changed=${(
          e: CustomEvent<{ labelKey: string; checked: boolean }>,
        ) => {
          const { labelKey, checked } = e.detail;
          if (labelKey === "game_settings.compact_map")
            this.change({
              gameMapSize: checked ? GameMapSize.Compact : GameMapSize.Normal,
              bots: getBotsForCompactMap(r.bots, checked),
              nations: sliderToNationsConfig(
                getNationsForCompactMap(
                  nationsConfigToSlider(r.nations, nationDefault),
                  nationDefault,
                  checked,
                ),
                nationDefault,
              ),
            });
          else if (labelKey === "game_settings.doomsday_clock")
            this.change({
              doomsdayClock: { ...r.doomsdayClock, enabled: checked },
            });
          else if (toggles[labelKey])
            this.change({ [toggles[labelKey]]: checked });
        }}
        @doomsday-clock-speed-selected=${(e: CustomEvent<{ speed: Rules["doomsdayClock"]["speed"] }>) => this.change({ doomsdayClock: { ...r.doomsdayClock, speed: e.detail.speed } })}
      ></game-config-settings>
    </div>`;
  }
}
