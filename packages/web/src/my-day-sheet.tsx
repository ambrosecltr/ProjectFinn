import {
  ArrowDown01Icon,
  SentIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, LayoutGroup, motion, type TargetAndTransition } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { DashRing } from "./components/loading-ui/dash-ring";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { MyDaySummaryCard } from "./my-day-summary-card";
import type { MyDayPage, MyDayTodo } from "./web-types";
export type { MyDayPage, MyDayTodo } from "./web-types";

export type MyDaySheetFrameProps = {
  title: string;
  children: ReactNode;
  className?: string;
};

interface TodoStackRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

interface TodoStackPadding {
  top: number;
  bottom: number;
}

const TODO_STACK_RADIUS = 15;
const TODO_ROW_PADDING_OUTER = 18;
const TODO_ROW_PADDING_COMPACT = 22;
const TODO_LAYOUT_TRANSITION = { type: "spring", stiffness: 380, damping: 34, mass: 0.78 } as const;
const TODO_ACCORDION_TRANSITION = { type: "spring", stiffness: 420, damping: 36, mass: 0.78 } as const;

export function MyDaySheet(props: {
  SheetComponent: (props: MyDaySheetFrameProps) => ReactNode;
  page: MyDayPage | null;
  loading: boolean;
  savingTodoIds: Set<string>;
  onCreateTodo: (title: string) => void;
  onUpdateTodo: (todo: MyDayTodo, patch: Partial<Pick<MyDayTodo, "title" | "notes" | "status">>) => void;
  onHandoff: (todo: MyDayTodo, context?: string) => void;
  onRequestDelete: (todo: MyDayTodo) => void;
  onHaptic?: () => void;
}) {
  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [expandedTodoId, setExpandedTodoId] = useState<string | null>(null);
  const newTodoInputRef = useRef<HTMLTextAreaElement | null>(null);
  const SheetComponent = props.SheetComponent;

  useLayoutEffect(() => {
    resizeTextarea(newTodoInputRef.current);
  }, [newTodoTitle]);

  function submitNewTodo() {
    const title = newTodoTitle.trim();
    if (!title) return;
    props.onCreateTodo(title);
    setNewTodoTitle("");
  }

  const visibleTodos = props.page?.todos.filter((todo) => todo.status !== "archived") ?? [];
  const openTodos = visibleTodos.filter((todo) => todo.status !== "done");
  const doneTodos = visibleTodos.filter((todo) => todo.status === "done");
  const todos = [...openTodos, ...doneTodos];
  const expandedTodoIndex = todos.findIndex((todo) => todo.id === expandedTodoId);
  const stackItemCount = todos.length + 1;

  return (
    <SheetComponent title="My day" className="my-day-sheet">
      <div className="my-day-sheet-body">
        {props.loading ? <LoadingView label="Loading your day..." /> : null}
        {!props.loading && props.page ? (
          <>
            <MyDaySummaryCard
              taskCount={visibleTodos.length}
              summary={props.page.day.summary || "Finn is still getting a feel for your day. Check back shortly and he should have a better sense of what needs your attention."}
              lastRefreshedAt={props.page.day.lastRefreshedAt}
            />
            <section className="my-day-todos-section">
              <div className="my-day-todo-list">
                <LayoutGroup>
                  <motion.ul className="my-day-todo-stack" layout transition={TODO_LAYOUT_TRANSITION}>
                    <AnimatePresence initial={false}>
                      {todos.map((todo, index) => (
                        <MyDayTodoRow
                          key={todo.id}
                          todo={todo}
                          index={index}
                          saving={props.savingTodoIds.has(todo.id)}
                          expanded={todo.id === expandedTodoId}
                          stackRadius={getTodoStackRadius(index, stackItemCount, expandedTodoIndex)}
                          stackPadding={getTodoStackPadding(index, stackItemCount, expandedTodoIndex)}
                          onToggleExpanded={() => { props.onHaptic?.(); setExpandedTodoId((current) => current === todo.id ? null : todo.id); }}
                          onUpdate={(patch) => props.onUpdateTodo(todo, patch)}
                          onHandoff={(context) => props.onHandoff(todo, context)}
                          onRequestDelete={() => props.onRequestDelete(todo)}
                        />
                      ))}
                    </AnimatePresence>
                    <TodoAddRow
                      title={newTodoTitle}
                      inputRef={newTodoInputRef}
                      stackRadius={getTodoStackRadius(todos.length, stackItemCount, expandedTodoIndex)}
                      stackPadding={getTodoStackPadding(todos.length, stackItemCount, expandedTodoIndex)}
                      empty={visibleTodos.length === 0}
                      onTitleChange={setNewTodoTitle}
                      onSubmit={submitNewTodo}
                    />
                  </motion.ul>
                </LayoutGroup>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </SheetComponent>
  );
}

function MyDayTodoRow(props: {
  todo: MyDayTodo;
  index: number;
  saving: boolean;
  expanded: boolean;
  stackRadius: TodoStackRadius;
  stackPadding: TodoStackPadding;
  onToggleExpanded: () => void;
  onUpdate: (patch: Partial<Pick<MyDayTodo, "title" | "notes" | "status">>) => void;
  onHandoff: (context?: string) => void;
  onRequestDelete: () => void;
}) {
  const [title, setTitle] = useState(props.todo.title);
  const [handoffContext, setHandoffContext] = useState("");
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const handoffInputRef = useRef<HTMLTextAreaElement | null>(null);
  const isDone = props.todo.status === "done";
  const handoffDisabled = props.saving || isDone || Boolean(props.todo.handoffAt);

  useEffect(() => {
    setTitle(props.todo.title);
  }, [props.todo.title]);

  useLayoutEffect(() => {
    resizeTextarea(titleInputRef.current);
  }, [title]);

  useLayoutEffect(() => {
    resizeTextarea(handoffInputRef.current);
  }, [handoffContext, props.expanded]);

  function saveTitle() {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setTitle(props.todo.title);
      return;
    }
    if (nextTitle !== props.todo.title) {
      props.onUpdate({ title: nextTitle });
    }
  }

  function submitHandoff() {
    if (handoffDisabled) return;
    const context = handoffContext.trim();
    props.onHandoff(context || undefined);
  }

  return (
    <motion.li
      layout
      className={cn("my-day-todo-card", isDone && "my-day-todo-row-done")}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        marginTop: props.expanded && props.index > 0 ? 14 : 0,
        marginBottom: props.expanded ? 14 : 0,
        borderTopColor: joinedTopBorderColor(props.stackRadius),
        ...todoRadiusAnimation(props.stackRadius),
      }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, scale: 0.98 }}
      transition={TODO_LAYOUT_TRANSITION}
      data-expanded={props.expanded || undefined}
    >
      <motion.div
        className="my-day-todo-row"
        transition={TODO_ACCORDION_TRANSITION}
        animate={{
          paddingTop: props.stackPadding.top,
          paddingBottom: props.stackPadding.bottom,
          ...todoRadiusAnimation(props.stackRadius),
        }}
      >
        <button
          className="my-day-checkbox"
          type="button"
          aria-label={isDone ? "Mark todo open" : "Mark todo done"}
          aria-pressed={isDone}
          disabled={props.saving}
          onClick={() => props.onUpdate({ status: isDone ? "open" : "done" })}
        >
          {isDone ? <HugeiconsIcon icon={Tick01Icon} size={16} strokeWidth={2.4} aria-hidden="true" /> : null}
        </button>
        <span className="my-day-todo-title-wrap">
          {isDone ? (
            <span className="my-day-todo-title my-day-todo-title-static">
              <span className="my-day-todo-title-text">{title}</span>
            </span>
          ) : (
            <textarea
              ref={titleInputRef}
              className="my-day-todo-title"
              value={title}
              aria-label="Todo title"
              rows={1}
              disabled={props.saving}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  setTitle(props.todo.title);
                  event.currentTarget.blur();
                }
              }}
            />
          )}
        </span>
        <motion.button
          className="my-day-accordion-toggle"
          type="button"
          aria-label={props.expanded ? `Hide options for ${props.todo.title}` : `Show options for ${props.todo.title}`}
          aria-expanded={props.expanded}
          disabled={props.saving}
          animate={{ rotate: props.expanded ? 180 : 0 }}
          transition={TODO_ACCORDION_TRANSITION}
          onClick={props.onToggleExpanded}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={18} strokeWidth={2.2} aria-hidden="true" />
        </motion.button>
      </motion.div>
      <AnimatePresence initial={false}>
        {props.expanded ? (
          <motion.div
            className="my-day-todo-panel"
            aria-hidden={!props.expanded}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TODO_ACCORDION_TRANSITION}
          >
            <div className="my-day-todo-panel-inner">
              {!isDone ? (
                <div className="my-day-handoff-card">
                  <textarea
                    ref={handoffInputRef}
                    className="my-day-handoff-input"
                    value={handoffContext}
                    placeholder="Handoff to Finn. You can add an optional message here too..."
                    aria-label="Optional handoff message"
                    rows={1}
                    disabled={handoffDisabled}
                    onChange={(event) => setHandoffContext(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        submitHandoff();
                      }
                    }}
                  />
                  <button className="my-day-handoff-send" type="button" aria-label="Handoff to Finn" disabled={handoffDisabled} onClick={submitHandoff}>
                    {props.saving ? <DashRing className="my-day-action-spinner" aria-hidden="true" /> : <HugeiconsIcon icon={SentIcon} size={17} strokeWidth={2.2} aria-hidden="true" />}
                  </button>
                </div>
              ) : null}
              <Button
                className="my-day-panel-button my-day-panel-delete-button"
                type="button"
                disabled={props.saving}
                onClick={props.onRequestDelete}
              >
                <span>Archive</span>
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.li>
  );
}

function TodoAddRow(props: {
  title: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  stackRadius: TodoStackRadius;
  stackPadding: TodoStackPadding;
  empty: boolean;
  onTitleChange: (title: string) => void;
  onSubmit: () => void;
}) {
  const canSubmit = Boolean(props.title.trim());

  return (
    <motion.li
      layout
      className="my-day-todo-card my-day-add-card"
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{
        opacity: 1,
        y: 0,
        scale: 1,
        marginBlock: 0,
        borderTopColor: joinedTopBorderColor(props.stackRadius),
        ...todoRadiusAnimation(props.stackRadius),
      }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, scale: 0.98 }}
      transition={TODO_LAYOUT_TRANSITION}
    >
      {props.empty ? <span className="my-day-empty-label">No todos yet.</span> : null}
      <motion.div
        className="my-day-todo-row my-day-add-row"
        animate={{
          paddingTop: props.stackPadding.top,
          paddingBottom: props.stackPadding.bottom,
          ...todoRadiusAnimation(props.stackRadius),
        }}
        transition={TODO_ACCORDION_TRANSITION}
      >
        <div className="my-day-add-pill">
          <textarea
            ref={props.inputRef}
            className="my-day-add-input"
            value={props.title}
            placeholder="Add a todo"
            aria-label="Add a todo"
            rows={1}
            onChange={(event) => props.onTitleChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                props.onSubmit();
              }
            }}
          />
          <button className="my-day-add-button" type="button" aria-label="Add todo" disabled={!canSubmit} onClick={props.onSubmit}>
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </motion.div>
    </motion.li>
  );
}

function LoadingView(props: { label: string }) {
  return (
    <div className="loading-view" role="status" aria-live="polite">
      <DashRing className="loading-view-spinner" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

function radiusValues(topLeft: number, topRight: number, bottomRight: number, bottomLeft: number): TodoStackRadius {
  return { topLeft, topRight, bottomRight, bottomLeft };
}

function getTodoStackRadius(index: number, count: number, expandedIndex: number): TodoStackRadius {
  if (count <= 1 || index === expandedIndex) return radiusValues(TODO_STACK_RADIUS, TODO_STACK_RADIUS, TODO_STACK_RADIUS, TODO_STACK_RADIUS);
  if (expandedIndex < 0) {
    if (index === 0) return radiusValues(TODO_STACK_RADIUS, TODO_STACK_RADIUS, 0, 0);
    if (index === count - 1) return radiusValues(0, 0, TODO_STACK_RADIUS, TODO_STACK_RADIUS);
    return radiusValues(0, 0, 0, 0);
  }

  const isAboveExpanded = index < expandedIndex;
  const segmentStart = isAboveExpanded ? 0 : expandedIndex + 1;
  const segmentEnd = isAboveExpanded ? expandedIndex - 1 : count - 1;

  if (index === segmentStart && index === segmentEnd) return radiusValues(TODO_STACK_RADIUS, TODO_STACK_RADIUS, TODO_STACK_RADIUS, TODO_STACK_RADIUS);
  if (index === segmentStart) return radiusValues(TODO_STACK_RADIUS, TODO_STACK_RADIUS, 0, 0);
  if (index === segmentEnd) return radiusValues(0, 0, TODO_STACK_RADIUS, TODO_STACK_RADIUS);
  return radiusValues(0, 0, 0, 0);
}

function getTodoStackPadding(index: number, count: number, expandedIndex: number): TodoStackPadding {
  if (count <= 1 || index === expandedIndex) return { top: TODO_ROW_PADDING_OUTER, bottom: TODO_ROW_PADDING_OUTER };
  if (expandedIndex < 0) {
    if (index === 0) return { top: TODO_ROW_PADDING_OUTER, bottom: TODO_ROW_PADDING_COMPACT };
    if (index === count - 1) return { top: TODO_ROW_PADDING_COMPACT, bottom: TODO_ROW_PADDING_OUTER };
    return { top: TODO_ROW_PADDING_COMPACT, bottom: TODO_ROW_PADDING_COMPACT };
  }

  const isAboveExpanded = index < expandedIndex;
  const segmentStart = isAboveExpanded ? 0 : expandedIndex + 1;
  const segmentEnd = isAboveExpanded ? expandedIndex - 1 : count - 1;

  if (index === segmentStart && index === segmentEnd) return { top: TODO_ROW_PADDING_OUTER, bottom: TODO_ROW_PADDING_OUTER };
  if (index === segmentStart) return { top: TODO_ROW_PADDING_OUTER, bottom: TODO_ROW_PADDING_COMPACT };
  if (index === segmentEnd) return { top: TODO_ROW_PADDING_COMPACT, bottom: TODO_ROW_PADDING_OUTER };
  return { top: TODO_ROW_PADDING_COMPACT, bottom: TODO_ROW_PADDING_COMPACT };
}

function todoRadiusAnimation(radius: TodoStackRadius): TargetAndTransition {
  return {
    borderTopLeftRadius: radius.topLeft,
    borderTopRightRadius: radius.topRight,
    borderBottomRightRadius: radius.bottomRight,
    borderBottomLeftRadius: radius.bottomLeft,
  };
}

function joinedTopBorderColor(radius: TodoStackRadius): string {
  return radius.topLeft === 0 && radius.topRight === 0 ? "transparent" : "#f7f7f7";
}

function resizeTextarea(element: HTMLTextAreaElement | null, maxRows = 3): void {
  if (!element) return;
  const computedStyle = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(computedStyle.fontSize) || 16;
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || fontSize * 1.2;
  const verticalPadding = Number.parseFloat(computedStyle.paddingTop) + Number.parseFloat(computedStyle.paddingBottom);
  const verticalBorder = Number.parseFloat(computedStyle.borderTopWidth) + Number.parseFloat(computedStyle.borderBottomWidth);
  const maxHeight = lineHeight * maxRows + verticalPadding + verticalBorder;

  element.style.height = "auto";
  const nextHeight = Math.min(element.scrollHeight, maxHeight);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
}
