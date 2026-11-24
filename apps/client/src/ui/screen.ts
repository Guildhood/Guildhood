export interface Screen {
  readonly el: HTMLElement;
  /** Called after the element is attached. */
  mounted?(): void;
  unmount(): void;
}
