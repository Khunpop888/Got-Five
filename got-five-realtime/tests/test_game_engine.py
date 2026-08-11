import base64
import sys
import unittest
from unittest.mock import patch
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))

import server  # noqa: E402


class GameEngineTests(unittest.TestCase):
    def make_room(self):
        first = server.create_player("Alice", "cyan", 0)
        second = server.create_player("Bob", "rose", 1)
        room = server.Room(code="TEST1", max_players=4, host_id=first.id, players=[first, second])
        server.start_room_game(room, starter_index=0)
        return room, first, second

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


if __name__ == "__main__":
    unittest.main()
