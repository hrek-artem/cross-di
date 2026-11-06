import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

const hoverCloseDelay = 300;

function nextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

export function useIslandExpansion(openOnHover: boolean, suspendAutoCollapse = false) {
  const suspended = useRef(suspendAutoCollapse);
  suspended.current = suspendAutoCollapse;
  const [expanded, setExpanded] = useState(false);
  const requested = useRef(false);
  const nativeExpanded = useRef(false);
  const resizing = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const capsule = useRef<HTMLDivElement>(null);

  const changeMode = useCallback(async (next: boolean) => {
    requested.current = next;
    if (resizing.current) return;
    resizing.current = true;

    try {
      while (nativeExpanded.current !== requested.current) {
        if (requested.current) {
          if (isTauri()) await invoke("set_island_expanded", { expanded: true });
          nativeExpanded.current = true;
          await nextPaint();
          if (requested.current) setExpanded(true);
        } else {
          setExpanded(false);
          await Promise.race([
            nextPaint().then(() => Promise.allSettled(
              capsule.current?.getAnimations().map((animation) => animation.finished) ?? [],
            )),
            new Promise<void>((resolve) => window.setTimeout(resolve, 300)),
          ]);
          if (requested.current) {
            setExpanded(true);
            continue;
          }
          if (isTauri()) await invoke("set_island_expanded", { expanded: false });
          nativeExpanded.current = false;
        }
      }
    } catch (error) {
      requested.current = nativeExpanded.current;
      setExpanded(nativeExpanded.current);
      console.error(error);
    } finally {
      resizing.current = false;
    }
  }, []);

  const cancelHoverClose = useCallback(() => window.clearTimeout(hoverTimer.current), []);
  const collapse = useCallback(() => {
    cancelHoverClose();
    void changeMode(false);
  }, [cancelHoverClose, changeMode]);

  useEffect(() => {
    if (!isTauri()) {
      function onOutsidePointer(event: globalThis.PointerEvent) {
        if (!suspended.current && event.target instanceof Node && !capsule.current?.contains(event.target)) collapse();
      }
      document.addEventListener("pointerdown", onOutsidePointer);
      return () => document.removeEventListener("pointerdown", onOutsidePointer);
    }

    let active = true;
    const subscription = listen("island-outside-click", () => { if (active && !suspended.current) collapse(); });
    void subscription.catch(console.error);
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten(), () => {});
    };
  }, [collapse]);

  useEffect(() => { cancelHoverClose(); return cancelHoverClose; }, [openOnHover, suspendAutoCollapse, cancelHoverClose]);

  function expand() {
    cancelHoverClose();
    void changeMode(true);
  }

  function onPointerEnter(event: PointerEvent<HTMLDivElement>) {
    if (!suspended.current && openOnHover && event.pointerType === "mouse") expand();
  }

  function onPointerLeave(event: PointerEvent<HTMLDivElement>) {
    if (suspended.current || !openOnHover || event.pointerType !== "mouse") return;
    cancelHoverClose();
    hoverTimer.current = window.setTimeout(collapse, hoverCloseDelay);
  }

  return { expanded, capsule, expand, collapse, onPointerEnter, onPointerLeave };
}
