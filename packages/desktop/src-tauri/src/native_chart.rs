use std::path::Path;

fn escape_xml(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            matches!(*character, '\u{9}' | '\u{A}' | '\u{D}') || *character >= '\u{20}'
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn coordinate(value: f64) -> String {
    format!("{value:.2}")
}

pub(crate) fn write_chart(
    output: &Path,
    title: &str,
    chart_type: &str,
    labels: &[String],
    values: &[f64],
) -> Result<(), String> {
    if labels.is_empty() || labels.len() != values.len() || labels.len() > 50 {
        return Err("chart labels and values must contain the same 1 to 50 items".into());
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err("chart values must be finite numbers".into());
    }
    if !matches!(chart_type, "bar" | "line") {
        return Err("chart type must be bar or line".into());
    }

    const WIDTH: f64 = 1200.0;
    const HEIGHT: f64 = 675.0;
    const LEFT: f64 = 100.0;
    const RIGHT: f64 = 70.0;
    const TOP: f64 = 110.0;
    const BOTTOM: f64 = 100.0;
    let plot_width = WIDTH - LEFT - RIGHT;
    let plot_height = HEIGHT - TOP - BOTTOM;
    let minimum = values.iter().copied().fold(0.0_f64, f64::min);
    let maximum = values.iter().copied().fold(0.0_f64, f64::max);
    let span = (maximum - minimum).max(1.0);
    let y = |value: f64| TOP + (maximum - value) / span * plot_height;
    let baseline = y(0.0);
    let step = plot_width / labels.len() as f64;

    let mut marks = String::new();
    let mut points = Vec::with_capacity(values.len());
    for (index, (label, value)) in labels.iter().zip(values).enumerate() {
        let center = LEFT + step * (index as f64 + 0.5);
        let value_y = y(*value);
        points.push(format!("{},{}", coordinate(center), coordinate(value_y)));
        if chart_type == "bar" {
            let top = value_y.min(baseline);
            let height = (value_y - baseline).abs().max(1.0);
            marks.push_str(&format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"8\" fill=\"#e15c38\"/>",
                coordinate(center - step * 0.31),
                coordinate(top),
                coordinate(step * 0.62),
                coordinate(height),
            ));
        }
        marks.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" class=\"label\">{}</text><text x=\"{}\" y=\"{}\" text-anchor=\"middle\" class=\"value\">{}</text>",
            coordinate(center),
            coordinate(HEIGHT - 55.0),
            escape_xml(label),
            coordinate(center),
            coordinate(value_y - 14.0),
            escape_xml(&value.to_string()),
        ));
    }
    if chart_type == "line" {
        marks.insert_str(
            0,
            &format!(
                "<polyline points=\"{}\" fill=\"none\" stroke=\"#e15c38\" stroke-width=\"8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
                points.join(" ")
            ),
        );
        for point in points {
            let (x, y) = point.split_once(',').unwrap();
            marks.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{y}\" r=\"9\" fill=\"#f7f3e8\" stroke=\"#e15c38\" stroke-width=\"6\"/>"
            ));
        }
    }
    let svg = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"675\" viewBox=\"0 0 1200 675\"><style>.title{{font:700 34px 'Arial Unicode MS','Microsoft YaHei',sans-serif;fill:#17324d}}.label{{font:18px 'Arial Unicode MS','Microsoft YaHei',sans-serif;fill:#263247}}.value{{font:700 17px 'Arial Unicode MS','Microsoft YaHei',sans-serif;fill:#17324d}}</style><rect width=\"1200\" height=\"675\" fill=\"#f7f3e8\"/><rect width=\"18\" height=\"675\" fill=\"#e15c38\"/><text x=\"70\" y=\"62\" class=\"title\">{}</text><line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#8b968f\" stroke-width=\"2\"/>{marks}</svg>",
        escape_xml(title),
        coordinate(LEFT),
        coordinate(baseline),
        coordinate(WIDTH - RIGHT),
        coordinate(baseline),
    );
    std::fs::write(output, svg).map_err(|error| format!("write SVG chart: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_safe_editable_bar_and_line_svg() {
        let directory = tempfile::tempdir().unwrap();
        for chart_type in ["bar", "line"] {
            let output = directory.path().join(format!("{chart_type}.svg"));
            write_chart(
                &output,
                "季度 <增长>",
                chart_type,
                &["一季度".into(), "二季度".into()],
                &[12.0, -3.0],
            )
            .unwrap();
            let svg = std::fs::read_to_string(output).unwrap();
            assert!(svg.contains("季度 &lt;增长&gt;"));
            assert!(svg.contains("一季度"));
            assert!(!svg.contains("季度 <增长>"));
        }
        assert!(write_chart(
            &directory.path().join("bad.svg"),
            "Bad",
            "pie",
            &["A".into()],
            &[1.0],
        )
        .is_err());
    }
}
