import base64
import io
import json
import sys
import unittest
from unittest.mock import patch
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))

import server  # noqa: E402


class GameEngineTests(unittest.TestCase):
    def masked_ws_frame(self, payload: bytes, opcode: int = 0x1, fin: bool = True) -> bytes:
        mask = b"\x13\x37\xaa\x55"
        first = (0x80 if fin else 0) | opcode
        header = bytearray([first])
        if len(payload) < 126:
            header.append(0x80 | len(payload))
        elif len(payload) < 65536:
            header.extend([0x80 | 126, (len(payload) >> 8) & 0xFF, len(payload) & 0xFF])
        else:
            raise AssertionError("test payload too large")
        header.extend(mask)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return bytes(header) + masked

    def make_ws_reader(self, *frames: bytes):
        handler = object.__new__(server.GotFiveHandler)
        handler.rfile = io.BytesIO(b"".join(frames))
        handler.wfile = io.BytesIO()
        return handler

    def make_room(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        room = server.Room(code="TEST1", max_players=4, host_id=first.id, players=[first, second])
        server.start_room_game(room, starter_index=0)
        return room, first, second

    def tile(self, num):
        return server.Tile(id=num, num=num, color_index=(num - 1) % 5, dots=(((num - 1) // 5) % 3) + 1)

    def test_owner_secret_tiles_are_masked_but_opponents_are_visible(self):
        room, alice, bob = self.make_room()

        alice_view = server.serialize_room(room, alice.id)
        bob_view = server.serialize_room(room, bob.id)

        alice_self_tiles = next(player for player in alice_view["players"] if player["id"] == alice.id)["tiles"]
        alice_seen_by_bob = next(player for player in bob_view["players"] if player["id"] == alice.id)["tiles"]

        self.assertTrue(all(tile["hidden"] for tile in alice_self_tiles))
        self.assertTrue(all("num" not in tile and "dots" not in tile and "id" not in tile for tile in alice_self_tiles))
        self.assertTrue(all(not tile["hidden"] for tile in alice_seen_by_bob))
        self.assertTrue(all("num" in tile and "dots" in tile for tile in alice_seen_by_bob))

    def test_categorise_places_center_tile_on_actor_rack(self):
        room, alice, bob = self.make_room()
        tile = room.center[0]
        expected_notch = sum(1 for secret in alice.tiles if tile.num > secret.num)

        server.apply_draw(room, alice, 0)
        server.apply_categorise(room, alice, bob.id, tile.id)

        self.assertIn(tile, alice.notches[expected_notch])
        self.assertNotIn(tile, bob.notches[expected_notch])
        self.assertNotIn(tile, room.center)
        self.assertEqual(alice.stats["categorises"], 1)
        self.assertEqual(bob.stats["cluesGiven"], 1)

    def test_compare_records_only_yes_no_result(self):
        room, alice, bob = self.make_room()
        tile = room.center[0]
        expected = tile.dots == alice.tiles[2].dots

        server.apply_draw(room, alice, 0)
        result = server.apply_compare(room, alice, bob.id, tile.id, 2)

        self.assertEqual(result["isSame"], expected)
        self.assertEqual(alice.compares[2][0]["isSame"], expected)
        self.assertNotIn(tile, room.center)
        self.assertEqual(alice.stats["compares"], 1)

    def test_correct_got_five_records_rank_and_match_continues_for_others(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        third = server.create_player("Cat", "emerald", 2)
        room = server.Room(code="TEST5", max_players=4, host_id=first.id, players=[first, second, third])
        server.start_room_game(room, starter_index=0)

        result = server.apply_guess(room, first, [tile.num for tile in first.tiles])

        self.assertTrue(result["isCorrect"])
        self.assertEqual(room.status, "playing")
        self.assertFalse(first.active)
        self.assertEqual(room.rankings[0]["playerId"], first.id)
        self.assertEqual(room.rankings[0]["rank"], 1)

        finished_view = server.serialize_room(room, first.id)
        own_tiles = next(player for player in finished_view["players"] if player["id"] == first.id)["tiles"]
        self.assertTrue(all(not tile["hidden"] for tile in own_tiles))

    def test_wrong_guess_eliminates_player_without_finishing_if_two_remain_before_turn_end(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        third = server.create_player("Cat", "emerald", 2)
        room = server.Room(code="TEST2", max_players=4, host_id=first.id, players=[first, second, third])
        server.start_room_game(room, starter_index=1)

        wrong_guess = [tile.num for tile in second.tiles]
        wrong_guess[0] = 60 if wrong_guess[0] != 60 else 59
        result = server.apply_guess(room, second, wrong_guess)

        self.assertFalse(result["isCorrect"])
        self.assertFalse(second.active)
        self.assertEqual(room.status, "playing")

    def test_final_ranking_keeps_finishers_before_eliminated_players(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        third = server.create_player("Cat", "emerald", 2)
        room = server.Room(code="TEST6", max_players=4, host_id=first.id, players=[first, second, third])
        server.start_room_game(room, starter_index=0)

        server.apply_guess(room, first, [tile.num for tile in first.tiles])
        wrong_guess = [tile.num for tile in second.tiles]
        wrong_guess[0] = 60 if wrong_guess[0] != 60 else 59
        server.apply_guess(room, second, wrong_guess)

        self.assertEqual(room.status, "finished")
        self.assertEqual([entry["playerId"] for entry in room.rankings], [first.id, third.id, second.id])
        self.assertEqual([entry["status"] for entry in room.rankings], ["winner", "survivor", "eliminated"])

    def test_four_player_match_keeps_running_until_all_ranks_are_set(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        third = server.create_player("Cat", "emerald", 2)
        fourth = server.create_player("Dee", "amber", 3)
        room = server.Room(code="TEST7", max_players=4, host_id=first.id, players=[first, second, third, fourth])
        server.start_room_game(room, starter_index=0)

        server.apply_guess(room, first, [tile.num for tile in first.tiles])
        self.assertEqual(room.status, "playing")
        self.assertEqual([entry["playerId"] for entry in room.rankings], [first.id])

        server.apply_guess(room, second, [tile.num for tile in second.tiles])
        self.assertEqual(room.status, "playing")
        self.assertEqual([entry["playerId"] for entry in room.rankings], [first.id, second.id])

        wrong_guess = [tile.num for tile in third.tiles]
        wrong_guess[0] = 60 if wrong_guess[0] != 60 else 59
        server.apply_guess(room, third, wrong_guess)

        self.assertEqual(room.status, "finished")
        self.assertEqual(
            [entry["playerId"] for entry in room.rankings],
            [first.id, second.id, fourth.id, third.id],
        )
        self.assertEqual(
            [entry["status"] for entry in room.rankings],
            ["winner", "finished", "survivor", "eliminated"],
        )

    def test_round_counts_full_table_cycles(self):
        room, alice, bob = self.make_room()
        self.assertEqual(server.round_info(room), {"current": 1, "completed": 0, "position": 1, "total": 2})

        server.end_turn(room)
        self.assertEqual(server.round_info(room), {"current": 1, "completed": 0, "position": 2, "total": 2})

        server.end_turn(room)
        self.assertEqual(server.round_info(room), {"current": 2, "completed": 1, "position": 1, "total": 2})

    def test_turn_timer_is_serialized_and_recorded_when_turn_ends(self):
        room, alice, bob = self.make_room()
        room.turn_started_at = 100

        with patch("server.time.time", return_value=107):
            server.end_turn(room)

        self.assertEqual(alice.stats["lastTurnSec"], 7)
        self.assertEqual(alice.stats["turnTimeTotalSec"], 7)
        self.assertEqual(alice.stats["slowestTurnSec"], 7)
        self.assertEqual(room.turn_started_at, 107)

        view = server.serialize_room(room, bob.id)
        self.assertEqual(view["room"]["turnStartedAt"], 107000)
        alice_public = next(player for player in view["players"] if player["id"] == alice.id)
        self.assertEqual(alice_public["stats"]["avgTurnSec"], 7)

    def test_private_board_mark_sends_compact_ack_without_full_room_state(self):
        room, alice, _bob = self.make_room()

        class FakeClient:
            def __init__(self):
                self.room_code = server.room_lookup_key(room.code)
                self.player_id = alice.id
                self.sent = []

            def send(self, event, data):
                self.sent.append((event, data))

        client = FakeClient()
        with server.ROOMS_LOCK:
            server.ROOMS[client.room_code] = room
            try:
                revision = room.revision
                server.handle_mark(client, {"num": 17, "marked": True})

                self.assertEqual(room.revision, revision)
                self.assertEqual(alice.marks, {17})
                self.assertEqual(client.sent, [("markUpdated", {"num": 17, "marked": True, "count": 1})])

                server.handle_mark(client, {"num": 17, "marked": False})
                self.assertEqual(alice.marks, set())
                self.assertEqual(client.sent[-1], ("markUpdated", {"num": 17, "marked": False, "count": 0}))
            finally:
                server.ROOMS.pop(client.room_code, None)

    def test_heartbeat_uses_compact_pong_without_room_state(self):
        class FakeClient:
            room_code = None
            player_id = None

            def __init__(self):
                self.sent = []

            def send(self, event, data):
                self.sent.append((event, data))

        client = FakeClient()
        with patch("server.time.time", return_value=123.456):
            server.handle_message(client, json.dumps({"event": "ping", "data": {}}))

        self.assertEqual(client.sent, [("pong", {"time": 123456})])

    def test_owner_key_is_required_for_public_room_creation(self):
        with patch.object(server, "OWNER_KEY", "secret-owner-code"):
            with self.assertRaises(server.GameError):
                server.require_owner_key({})
            with self.assertRaises(server.GameError):
                server.require_owner_key({"ownerKey": "wrong"})

            server.require_owner_key({"ownerKey": "secret-owner-code"})

    def test_custom_room_code_accepts_thai_and_blocks_unsafe_paths(self):
        self.assertEqual(server.sanitize_room_code("ไส้ตัน"), "ไส้ตัน")
        self.assertEqual(server.sanitize_room_code(" enjoy "), "enjoy")
        self.assertEqual(server.room_lookup_key("Enjoy"), server.room_lookup_key("enjoy"))

        for value in ["bad room", "bad/room", "bad?room", "bad#room"]:
            with self.assertRaises(server.GameError):
                server.sanitize_room_code(value)

    def test_create_room_can_use_custom_room_code_case_insensitive(self):
        class FakeClient:
            def __init__(self):
                self.room_code = None
                self.player_id = None
                self.sent = []

            def send(self, event, data):
                self.sent.append((event, data))

        with patch.object(server, "OWNER_KEY", "secret-owner-code"):
            with server.ROOMS_LOCK:
                server.ROOMS.clear()
                first = FakeClient()
                server.handle_create_room(first, {
                    "ownerKey": "secret-owner-code",
                    "roomCode": "enjoy",
                    "name": "Host",
                    "color": "cyan",
                })
                self.assertIn(server.room_lookup_key("ENJOY"), server.ROOMS)
                self.assertEqual(first.sent[-1][1]["room"]["code"], "enjoy")

                with self.assertRaises(server.GameError):
                    server.handle_create_room(FakeClient(), {
                        "ownerKey": "secret-owner-code",
                        "roomCode": "ENJOY",
                        "name": "Other",
                        "color": "blue",
                    })
                server.ROOMS.clear()

    def test_avatar_sanitizer_accepts_small_safe_images_only(self):
        raw = base64.b64encode(b"small-avatar").decode("ascii")
        self.assertEqual(server.sanitize_avatar(f"data:image/png;base64,{raw}"), f"data:image/png;base64,{raw}")
        self.assertEqual(server.sanitize_avatar(f"data:image/svg+xml;base64,{raw}"), "")
        self.assertEqual(server.sanitize_avatar("not-a-data-url"), "")

    def test_player_avatar_is_public_profile_not_secret_state(self):
        raw = base64.b64encode(b"small-avatar").decode("ascii")
        avatar = f"data:image/png;base64,{raw}"
        first = server.create_player("Alice", "cyan", 0, avatar=avatar)
        second = server.create_player("Bob", "rose", 1)
        room = server.Room(code="TEST3", max_players=4, host_id=first.id, players=[first, second])

        view = server.serialize_room(room, second.id)
        alice = next(player for player in view["players"] if player["id"] == first.id)
        self.assertEqual(alice["avatar"], avatar)

        server.add_log(room, "draw", first.id, "Alice drew a tile")
        self.assertEqual(room.log[-1]["actorAvatar"], avatar)

    def test_starting_player_is_randomized_by_server(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        third = server.create_player("Cat", "emerald", 2)
        room = server.Room(code="TEST4", max_players=4, host_id=first.id, players=[first, second, third])

        with patch("server.secrets.randbelow", return_value=2) as mocked:
            server.start_room_game(room)

        mocked.assert_called_once_with(3)
        self.assertEqual(room.turn_index, 2)
        self.assertEqual(room.starter_id, third.id)
        self.assertEqual(server.current_player(room).id, third.id)

        view = server.serialize_room(room, first.id)
        self.assertEqual(view["room"]["starterId"], third.id)

    def test_bot_certain_guess_uses_public_deduction_not_secret_numbers(self):
        bot = server.create_player("Bot", "cyan", 0, kind="bot")
        human = server.create_player("Human", "rose", 1)
        room = server.Room(code="BOT01", max_players=2, host_id=human.id, players=[bot, human])
        room.status = "playing"
        room.phase = "draw"
        bot.tiles = [self.tile(num) for num in [56, 57, 58, 59, 60]]
        bot.notches = [[], [], [], [], [], [self.tile(6)]]
        bot.compares = [[] for _ in range(5)]

        guess = server.bot_certain_guess(room, bot)

        self.assertEqual(guess, [1, 2, 3, 4, 5])
        self.assertNotEqual(guess, [tile.num for tile in bot.tiles])

    def test_bot_certain_guess_waits_when_deduction_is_not_unique(self):
        bot = server.create_player("Bot", "cyan", 0, kind="bot")
        human = server.create_player("Human", "rose", 1)
        room = server.Room(code="BOT02", max_players=2, host_id=human.id, players=[bot, human])
        room.status = "playing"
        room.phase = "draw"
        bot.tiles = [self.tile(num) for num in [1, 2, 3, 4, 5]]
        bot.notches = [[], [], [], [], [], [self.tile(11)]]
        bot.compares = [[] for _ in range(5)]

        self.assertIsNone(server.bot_certain_guess(room, bot))

    def test_multi_match_series_waits_until_final_match_for_awards(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        room = server.Room(code="SER01", max_players=2, host_id=first.id, players=[first, second], match_total=2)

        server.start_room_game(room, starter_index=0)
        server.apply_guess(room, first, [tile.num for tile in first.tiles])

        self.assertEqual(room.status, "between_matches")
        self.assertEqual(room.match_index, 1)
        self.assertEqual(len(room.match_history), 1)
        series = server.summarize_series(room)
        self.assertFalse(series["isFinal"])
        self.assertEqual(series["completed"], 1)
        self.assertEqual(series["standings"][0]["playerId"], first.id)
        self.assertEqual(series["standings"][0]["wins"], 1)

        server.start_room_game(room, starter_index=1)
        self.assertEqual(room.match_index, 2)
        server.apply_guess(room, second, [tile.num for tile in second.tiles])

        self.assertEqual(room.status, "finished")
        final_series = server.summarize_series(room)
        self.assertTrue(final_series["isFinal"])
        self.assertEqual(final_series["completed"], 2)
        self.assertEqual(sum(entry["wins"] for entry in final_series["standings"]), 2)
        self.assertEqual(len(final_series["history"]), 2)

    def test_websocket_reader_reassembles_fragmented_text_frames(self):
        message = json.dumps(
            {"event": "createRoom", "data": {"name": "Alice", "avatar": "x" * 240}},
            ensure_ascii=False,
        )
        payload = message.encode("utf-8")
        reader = self.make_ws_reader(
            self.masked_ws_frame(payload[:52], opcode=0x1, fin=False),
            self.masked_ws_frame(b"keepalive", opcode=0x9, fin=True),
            self.masked_ws_frame(payload[52:160], opcode=0x0, fin=False),
            self.masked_ws_frame(payload[160:], opcode=0x0, fin=True),
        )

        self.assertEqual(reader.read_ws_text(), message)
        pong = reader.wfile.getvalue()
        self.assertTrue(pong.startswith(b"\x8a"))


if __name__ == "__main__":
    unittest.main()
