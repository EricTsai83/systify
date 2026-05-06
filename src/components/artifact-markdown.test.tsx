// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ArtifactMarkdown } from "./artifact-markdown";

afterEach(() => {
  cleanup();
});

describe("ArtifactMarkdown", () => {
  test("renders ATX headings as semantic heading tags", () => {
    render(<ArtifactMarkdown source={"# H1\n## H2\n### H3\n#### H4"} />);
    expect(screen.getByRole("heading", { level: 3, name: "H1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "H2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 5, name: "H3" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 6, name: "H4" })).toBeInTheDocument();
  });

  test("collapses contiguous bullet lines into a single list", () => {
    render(<ArtifactMarkdown source={"- one\n- two\n* three"} />);
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  test("renders fenced code blocks verbatim", () => {
    render(<ArtifactMarkdown source={"```ts\nconst x = 1;\n```"} />);
    const code = screen.getByText("const x = 1;");
    expect(code.tagName).toBe("CODE");
  });

  test("does not run away on an unclosed fence", () => {
    // The parser should consume to EOF and still surface the captured content
    // rather than dropping it or hanging.
    render(<ArtifactMarkdown source={"```\nrunaway content\nthe rest of the doc"} />);
    expect(screen.getByText(/runaway content/)).toBeInTheDocument();
  });

  test("renders inline code, bold, and italic", () => {
    const { container } = render(<ArtifactMarkdown source={"Use `foo` with **bold** and *emphasis*."} />);
    expect(container.querySelector("code")?.textContent).toBe("foo");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("emphasis");
  });

  test("escapes HTML in source so embedded tags do not become DOM", () => {
    const { container } = render(<ArtifactMarkdown source={"<script>alert(1)</script> end"} />);
    // No <script> escapes into the DOM — the literal string is rendered as
    // text inside a paragraph.
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script> end/)).toBeInTheDocument();
  });

  test("blank lines act as paragraph separators", () => {
    const { container } = render(<ArtifactMarkdown source={"first\n\nsecond"} />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("first");
    expect(paragraphs[1].textContent).toBe("second");
  });
});
