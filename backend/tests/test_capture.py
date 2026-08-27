"""
backend/tests/test_capture.py — regression tests for capture.py's file-size
cap and rotation (2026-08-30 sprint; see docs/idealization_report.md,
2026-08-29 sprint's "Remaining known gaps" #3, and the 2026-08-27 sprint for
the asyncio.to_thread wrapping this module's caller already has).

`app.api.capture._CAPTURE_PATH` is read once from IYE_CAPTURE_PATH at
import time — setting the env var mid-test wouldn't take effect, so every
test here monkeypatches the module's already-imported `_CAPTURE_PATH` (and,
where relevant, `MAX_CAPTURE_FILE_BYTES`) directly instead.
"""

from __future__ import annotations

import json

import numpy as np

from app.api import capture


def test_is_capture_enabled_reflects_capture_path(monkeypatch):
    monkeypatch.setattr(capture, "_CAPTURE_PATH", None)
    assert capture.is_capture_enabled() is False

    monkeypatch.setattr(capture, "_CAPTURE_PATH", "/tmp/whatever.jsonl")
    assert capture.is_capture_enabled() is True


def test_capture_frame_is_a_true_no_op_when_disabled(tmp_path, monkeypatch):
    target = tmp_path / "capture.jsonl"
    monkeypatch.setattr(capture, "_CAPTURE_PATH", None)

    capture.capture_frame(
        coordinates=np.array([[1.0, 2.0, 3.0]]),
        timestamp="2026-08-29T00:00:00Z",
        anomaly_indices=[],
        cluster_labels=[0],
    )

    assert not target.exists()


def test_capture_frame_appends_one_well_formed_jsonl_line(tmp_path, monkeypatch):
    target = tmp_path / "capture.jsonl"
    monkeypatch.setattr(capture, "_CAPTURE_PATH", str(target))

    capture.capture_frame(
        coordinates=np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]),
        timestamp="2026-08-29T00:00:00Z",
        anomaly_indices=[1],
        cluster_labels=[0, -1],
    )

    lines = target.read_text().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record == {
        "timestamp": "2026-08-29T00:00:00Z",
        "coordinates": [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
        "anomaly_indices": [1],
        "cluster_labels": [0, -1],
    }


def test_capture_frame_appends_across_multiple_calls(tmp_path, monkeypatch):
    target = tmp_path / "capture.jsonl"
    monkeypatch.setattr(capture, "_CAPTURE_PATH", str(target))

    for i in range(3):
        capture.capture_frame(
            coordinates=np.array([[float(i), 0.0, 0.0]]),
            timestamp=f"2026-08-29T00:00:0{i}Z",
            anomaly_indices=[],
            cluster_labels=[0],
        )

    lines = target.read_text().splitlines()
    assert len(lines) == 3
    assert [json.loads(line)["timestamp"] for line in lines] == [
        "2026-08-29T00:00:00Z",
        "2026-08-29T00:00:01Z",
        "2026-08-29T00:00:02Z",
    ]


class TestRotation:
    """MAX_CAPTURE_FILE_BYTES is monkeypatched small in every test here so
    rotation can be exercised without writing real 100MB files."""

    def test_no_rotation_while_under_the_cap(self, tmp_path, monkeypatch):
        target = tmp_path / "capture.jsonl"
        monkeypatch.setattr(capture, "_CAPTURE_PATH", str(target))
        monkeypatch.setattr(capture, "MAX_CAPTURE_FILE_BYTES", 10_000)

        capture.capture_frame(
            coordinates=np.array([[1.0, 2.0, 3.0]]),
            timestamp="t",
            anomaly_indices=[],
            cluster_labels=[0],
        )

        assert target.exists()
        assert not (tmp_path / "capture.jsonl.1").exists()

    def test_rotates_to_dot_1_once_the_cap_is_reached(self, tmp_path, monkeypatch):
        target = tmp_path / "capture.jsonl"
        backup = tmp_path / "capture.jsonl.1"
        monkeypatch.setattr(capture, "_CAPTURE_PATH", str(target))
        # A tiny cap -- the first write already puts the file at/over it, so
        # the *second* call must rotate before writing its own line.
        monkeypatch.setattr(capture, "MAX_CAPTURE_FILE_BYTES", 5)

        capture.capture_frame(
            coordinates=np.array([[1.0, 2.0, 3.0]]),
            timestamp="first",
            anomaly_indices=[],
            cluster_labels=[0],
        )
        first_content = target.read_text()
        assert "first" in first_content

        capture.capture_frame(
            coordinates=np.array([[4.0, 5.0, 6.0]]),
            timestamp="second",
            anomaly_indices=[],
            cluster_labels=[0],
        )

        # The oversized first file was rotated out to .1, untouched...
        assert backup.exists()
        assert backup.read_text() == first_content
        # ...and the active file now holds only the new line, not both.
        active_lines = target.read_text().splitlines()
        assert len(active_lines) == 1
        assert json.loads(active_lines[0])["timestamp"] == "second"

    def test_a_second_rotation_overwrites_the_previous_backup_rather_than_accumulating(
        self, tmp_path, monkeypatch
    ):
        target = tmp_path / "capture.jsonl"
        backup = tmp_path / "capture.jsonl.1"
        monkeypatch.setattr(capture, "_CAPTURE_PATH", str(target))
        monkeypatch.setattr(capture, "MAX_CAPTURE_FILE_BYTES", 5)

        capture.capture_frame(
            coordinates=np.array([[1.0]]), timestamp="gen1", anomaly_indices=[], cluster_labels=[0]
        )
        capture.capture_frame(  # rotates gen1 -> .1
            coordinates=np.array([[2.0]]), timestamp="gen2", anomaly_indices=[], cluster_labels=[0]
        )
        capture.capture_frame(  # gen2 is now oversized too -> rotates gen2 -> .1, clobbering gen1's backup
            coordinates=np.array([[3.0]]), timestamp="gen3", anomaly_indices=[], cluster_labels=[0]
        )

        assert "gen2" in backup.read_text()
        assert "gen1" not in backup.read_text()  # not accumulated as .2, just gone
        assert json.loads(target.read_text().splitlines()[0])["timestamp"] == "gen3"

    def test_rotation_is_a_no_op_on_the_very_first_write_ever(self, tmp_path, monkeypatch):
        # _rotate_if_needed must not blow up (e.g. FileNotFoundError) when
        # the capture file has never been created yet.
        target = tmp_path / "capture.jsonl"
        monkeypatch.setattr(capture, "_CAPTURE_PATH", str(target))
        monkeypatch.setattr(capture, "MAX_CAPTURE_FILE_BYTES", 1)

        capture.capture_frame(
            coordinates=np.array([[1.0]]), timestamp="only", anomaly_indices=[], cluster_labels=[0]
        )

        assert target.exists()
        assert not (tmp_path / "capture.jsonl.1").exists()
