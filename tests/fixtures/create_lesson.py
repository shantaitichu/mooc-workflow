"""Generate the two-slide import fixture with python-pptx."""

from pathlib import Path

from pptx import Presentation
from pptx.util import Inches


if __name__ == "__main__":
    output = Path(__file__).with_name("lesson.pptx")
    if output.exists():
        raise SystemExit("lesson.pptx already exists")
    deck = Presentation()
    deck.slide_width = Inches(12)
    deck.slide_height = Inches(6.75)
    for title, notes in [
        ("第一章 示例", "这是第一页的讲稿。"),
        ("第二章 示例", "这是第二页的讲稿。"),
    ]:
        slide = deck.slides.add_slide(deck.slide_layouts[5])
        slide.shapes.title.text = title
        slide.notes_slide.notes_text_frame.text = notes
    deck.save(output)
