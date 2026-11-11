import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Keypad, PinDots, Segmented, Select, Stepper, Switch } from "./components";

const I = <i />;
describe("Stepper", () => {
  it("steps within bounds and disables the buttons at the limits", async () => {
    const on = vi.fn(); const { rerender } = render(<Stepper value={1} min={1} max={3} onChange={on} decrementIcon={I} incrementIcon={I} />);
    expect(screen.getByRole("button", { name: /decrease quantity/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /increase quantity/i })); expect(on).toHaveBeenCalledWith(2);
    rerender(<Stepper value={3} min={1} max={3} onChange={on} decrementIcon={I} incrementIcon={I} />);
    expect(screen.getByRole("button", { name: /increase quantity/i })).toBeDisabled();
  });
});
describe("Segmented", () => {
  const Demo = () => { const [v, setV] = useState<"cash" | "card" | "other">("cash"); return <Segmented label="Tender" value={v} onChange={setV} options={[{ value: "cash", label: "Cash" }, { value: "card", label: "Card" }, { value: "other", label: "Other" }]} />; };
  it("is a radiogroup; arrows move and wrap; only the selected radio is tabbable", async () => {
    render(<Demo />);
    const cash = screen.getByRole("radio", { name: "Cash" }), card = screen.getByRole("radio", { name: "Card" });
    expect(cash).toHaveAttribute("aria-checked", "true"); expect(cash).toHaveAttribute("tabindex", "0"); expect(card).toHaveAttribute("tabindex", "-1");
    cash.focus(); await userEvent.keyboard("{ArrowRight}");
    expect(card).toHaveAttribute("aria-checked", "true"); expect(card).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}"); expect(cash).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowLeft}"); expect(screen.getByRole("radio", { name: "Other" })).toHaveAttribute("aria-checked", "true");
  });
});
describe("Switch", () => { it("toggles with click and keyboard", async () => { const Demo = () => { const [c, s] = useState(false); return <Switch checked={c} onChange={s}>Email receipt</Switch>; }; render(<Demo />); const sw = screen.getByRole("switch", { name: "Email receipt" }); expect(sw).toHaveAttribute("aria-checked", "false"); await userEvent.click(sw); expect(sw).toHaveAttribute("aria-checked", "true"); sw.focus(); await userEvent.keyboard(" "); expect(sw).toHaveAttribute("aria-checked", "false"); }); });
describe("Select", () => {
  const opts = [{ value: "a", label: "Counting error" }, { value: "b", label: "Damaged in store" }, { value: "c", label: "Supplier short-shipment" }];
  const Demo = ({ onPick }: { onPick?: (v: string) => void }) => { const [v, s] = useState<string | null>(null); return <Select label="Reason" options={opts} value={v} onChange={(x) => { s(x); onPick?.(x); }} />; };
  it("opens with Enter, moves with arrows, picks with Enter, closes with Escape, and returns focus", async () => {
    const pick = vi.fn(); render(<Demo onPick={pick} />); const box = screen.getByRole("combobox", { name: "Reason" });
    expect(box).toHaveAttribute("aria-expanded", "false"); box.focus();
    await userEvent.keyboard("{Enter}"); expect(box).toHaveAttribute("aria-expanded", "true"); expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}"); expect(box.getAttribute("aria-activedescendant")).toMatch(/-2$/);
    await userEvent.keyboard("{Enter}"); expect(pick).toHaveBeenCalledWith("c"); expect(box).toHaveAttribute("aria-expanded", "false"); expect(box).toHaveFocus(); expect(box).toHaveTextContent("Supplier short-shipment");
    await userEvent.keyboard("{Enter}{Escape}"); expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("typing jumps to a matching option; clicking an option picks it; clicking outside closes", async () => {
    const pick = vi.fn(); render(<Demo onPick={pick} />); const box = screen.getByRole("combobox"); box.focus();
    await userEvent.keyboard("{Enter}d"); expect(box.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    await userEvent.click(screen.getByRole("option", { name: "Counting error" })); expect(pick).toHaveBeenCalledWith("a");
    await userEvent.click(box); expect(screen.getByRole("listbox")).toBeInTheDocument(); fireEvent.pointerDown(document.body); expect(screen.queryByRole("listbox")).toBeNull();
  });
});
describe("Keypad and PinDots", () => {
  it("buttons and the hardware keyboard both feed digits; backspace and enter work; disabled blocks input", async () => {
    const d = vi.fn(), b = vi.fn(), s = vi.fn(); const { rerender } = render(<Keypad onDigit={d} onBackspace={b} onSubmit={s} backspaceIcon={I} submitIcon={I} />);
    await userEvent.click(screen.getByRole("button", { name: "7" })); expect(d).toHaveBeenLastCalledWith("7");
    await userEvent.keyboard("42"); expect(d).toHaveBeenCalledWith("4"); expect(d).toHaveBeenCalledWith("2");
    await userEvent.keyboard("{Backspace}"); expect(b).toHaveBeenCalled(); await userEvent.keyboard("{Enter}"); expect(s).toHaveBeenCalled();
    d.mockClear(); rerender(<Keypad onDigit={d} onBackspace={b} onSubmit={s} backspaceIcon={I} submitIcon={I} disabled />); await userEvent.keyboard("5"); expect(d).not.toHaveBeenCalled();
  });
  it("PinDots announce progress without revealing digits", () => { render(<PinDots length={4} filled={3} />); expect(screen.getByRole("img", { name: "PIN: 3 of 4 digits entered" })).toBeInTheDocument(); });
});

import { DatePicker, DropZone, formatYmd } from "./components";
describe("DatePicker", () => {
  const Demo = ({ onPick }: { onPick?: (v: string) => void }) => { const [v, s] = useState("2026-11-03"); return <DatePicker label="Business day" today="2026-11-04" value={v} onChange={(x) => { s(x); onPick?.(x); }} prevIcon={<i />} nextIcon={<i />} />; };
  it("opens a calendar dialog on the selected month; arrows, PageDown, Home/End and Enter pick the right date; Escape returns focus", async () => {
    const pick = vi.fn(); render(<Demo onPick={pick} />); const btn = screen.getByRole("button", { name: /Business day: Tue 3 Nov 2026/ });
    await userEvent.click(btn); expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Tue 3 Nov 2026" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}"); expect(screen.getByRole("button", { name: "Wed 4 Nov 2026" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}"); expect(screen.getByRole("button", { name: "Wed 11 Nov 2026" })).toHaveFocus();
    await userEvent.keyboard("{PageDown}"); expect(screen.getByRole("button", { name: "Fri 11 Dec 2026" })).toHaveFocus();
    await userEvent.keyboard("{Home}"); expect(screen.getByRole("button", { name: "Mon 7 Dec 2026" })).toHaveFocus(); await userEvent.keyboard("{End}"); expect(screen.getByRole("button", { name: "Sun 13 Dec 2026" })).toHaveFocus();
    await userEvent.keyboard("{Enter}"); expect(pick).toHaveBeenCalledWith("2026-12-13"); expect(screen.queryByRole("dialog")).toBeNull(); expect(btn).toHaveFocus();
    await userEvent.click(btn); await userEvent.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("month arithmetic clamps the day (31 Jan -> 28 Feb), marks today and the selection, and respects min/max", async () => {
    const pick = vi.fn(); const { rerender } = render(<DatePicker label="Day" today="2026-02-10" value="2026-01-31" onChange={pick} prevIcon={<i />} nextIcon={<i />} min="2026-01-15" max="2026-03-10" />);
    await userEvent.click(screen.getByRole("button", { name: /Day:/ })); await userEvent.keyboard("{PageDown}"); expect(screen.getByRole("button", { name: "Sat 28 Feb 2026" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Tue 10 Feb 2026" })).toHaveClass("today");
    await userEvent.click(screen.getByRole("button", { name: "Next month" })); expect(screen.getByRole("button", { name: "Sat 14 Mar 2026" })).toBeDisabled();
    rerender(<DatePicker label="Day" today="2026-02-10" value="2026-01-31" onChange={pick} prevIcon={<i />} nextIcon={<i />} />); expect(pick).not.toHaveBeenCalled();
  });
  it("formats and a click outside closes", async () => { expect(formatYmd("2026-11-03")).toBe("Tue 3 Nov 2026"); render(<Demo />); await userEvent.click(screen.getByRole("button", { name: /Business day/ })); fireEvent.pointerDown(document.body); expect(screen.queryByRole("dialog")).toBeNull(); });
});
describe("DropZone", () => {
  it("passes dropped files and chosen files to the handler; the file input is hidden", async () => {
    const got = vi.fn(); const { container } = render(<DropZone label="Drop a CSV" onFiles={got} accept=".csv" />);
    const f = new File(["a,b"], "x.csv", { type: "text/csv" }); fireEvent.drop(screen.getByText("Drop a CSV").parentElement!, { dataTransfer: { files: [f] } }); expect(got).toHaveBeenCalledWith([f]);
    const input = container.querySelector("input[type=file]") as HTMLInputElement; expect(input.hidden).toBe(true); await userEvent.upload(input, f, { applyAccept: false }); expect(got).toHaveBeenCalledTimes(2);
  });
});
