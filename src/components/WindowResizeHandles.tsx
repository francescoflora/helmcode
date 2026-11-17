import { startResize, type ResizeDirection } from "../lib/window";

type Props = {
  hidden: boolean;
};

const handles: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "left-2 right-2 top-0 h-1 cursor-ns-resize" },
  { direction: "South", className: "left-2 right-2 bottom-0 h-1 cursor-ns-resize" },
  { direction: "West", className: "top-2 bottom-2 left-0 w-1 cursor-ew-resize" },
  { direction: "East", className: "top-2 bottom-2 right-0 w-1 cursor-ew-resize" },
  { direction: "NorthWest", className: "left-0 top-0 h-2 w-2 cursor-nwse-resize" },
  { direction: "NorthEast", className: "right-0 top-0 h-2 w-2 cursor-nesw-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 h-2 w-2 cursor-nesw-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 h-2 w-2 cursor-nwse-resize" },
];

export function WindowResizeHandles({ hidden }: Props) {
  if (hidden) return null;

  return (
    <>
      {handles.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void startResize(handle.direction);
          }}
          className={`fixed z-[70] ${handle.className}`}
        />
      ))}
    </>
  );
}
