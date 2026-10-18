"""Generate OCR regression assets entirely from invented test data, without source documents."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'fixtures'
FONT_PATH = os.environ.get('MONEYSAVER_TEST_FONT', 'C:/Windows/Fonts/arial.ttf')
FONT = ImageFont.truetype(FONT_PATH, 40)
SMALL = ImageFont.truetype(FONT_PATH, 28)


def visual(text):
    # All Hebrew cells are plain Hebrew words; digits and English use separate cells.
    return text[::-1] if any('\u0590' <= ch <= '\u05ff' for ch in text) else text


def cell(draw, text, left, top, right, font=FONT):
    lines = text.split('\n')
    for i, line in enumerate(lines):
        label = visual(line)
        width = draw.textbbox((0, 0), label, font=font)[2]
        draw.text(((left + right - width) / 2, top + 8 + i * 36), label, font=font, fill='black')


# Synthetic dates, merchant names, amounts and identifiers; no input documents are read.
rows = [
    ('02/03/2024', 'חנות דוגמה מרכז', '41.00'),
    ('03/03/2024', 'חנות דוגמה', '26.00'),
    ('03/03/2024', 'SAMPLE STORE', '520.00'),
    ('03/03/2024', 'בית קפה דוגמה', '8.50'),
    ('03/03/2024', 'מרכול דוגמה', '142.61'),
    ('03/03/2024', 'SAMPLE ASIAN\nFOODBAR', '219.00'),
    ('05/03/2024', 'חנות צעצועים', '302.44'),
    ('06/03/2024', 'ממתקי דוגמה', '29.00'),
    ('07/03/2024', 'מרכול מרכז', '15.60'),
    ('07/03/2024', 'חנות בגדים', '112.40'),
    ('08/03/2024', 'בית מרקחת מרכז', '411.30'),
    ('08/03/2024', 'SAMPLE COFFEE', '18.00'),
]


def table(selected, borders):
    image = Image.new('RGB', (1800, 120 + (len(selected) + 1) * 100), 'white')
    draw = ImageDraw.Draw(image)
    columns = [35, 245, 435, 740, 1460, 1765]
    headers = ['סכום', 'הצגת כרטיס', 'מספר זיהוי', 'תיאור פעולה', 'תאריך']
    for i, text in enumerate(headers):
        cell(draw, text, columns[i], 30, columns[i + 1], SMALL)
    for r, (date, merchant, amount) in enumerate(selected):
        values = [amount, 'לא', str(9000001 + r), merchant, date]
        for i, text in enumerate(values):
            cell(draw, text, columns[i], 112 + r * 100, columns[i + 1])
    if borders:
        for x in columns:
            draw.line((x, 22, x, 104 + len(selected) * 100), fill=(100, 100, 100), width=3)
        for r in range(len(selected) + 2):
            y = 22 if r == 0 else 104 + (r - 1) * 100
            draw.line((columns[0], y, columns[-1], y), fill=(100, 100, 100), width=3)
    return image


plain = Image.new('RGB', (1800, 360), 'white')
draw = ImageDraw.Draw(plain)
draw.text((100, 70), '02/03/2024 SAMPLE CAFE 24.50', font=FONT, fill='black')
draw.text((100, 210), '05/03/2024 SAMPLE MARKET 132.40', font=FONT, fill='black')
plain.save(OUT / 'ocr-sample.png')
table([rows[0], ('03/03/2024', 'SAMPLE ASIAN FOODBAR', '219.00'), rows[7]], False).save(OUT / 'ocr-table-sample.png')
bordered = table(rows, True)
bordered.save(OUT / 'ocr-table-borders.png')
bordered.resize((735, round(bordered.height * 735 / bordered.width)), Image.Resampling.LANCZOS).save(OUT / 'ocr-table-lowres.jpg', quality=85)
print('Generated four synthetic OCR fixtures.')
