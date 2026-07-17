#!/usr/bin/env python3
"""Tests for goviral-daily-ops-report digest builder.

Validates:
  1. Correct registered-agent semantics (Brain snapshot, not thread count)
  2. Zero-run state
  3. Drift state rendering
  4. Partial snapshot failure
  5. Message-length bounding
  6. Secret redaction
  7. Backward compatibility with v2 agent summary
  8. Integration state rendering
  9. Brain inventory rendering
"""
import importlib.machinery
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# Load the report module from its non-standard filename (no .py extension)
REPORT_PATH = str(Path(__file__).parent / 'goviral-daily-ops-report')
loader = importlib.machinery.SourceFileLoader('report', REPORT_PATH)
spec = importlib.util.spec_from_loader('report', loader)
assert spec is not None
report = importlib.util.module_from_spec(spec)
loader.exec_module(report)


def make_brain_overview(
    registered=8, enabled=7, active_now=2, runs_24h=5,
    registry_drift=1, drift_count=1,
    skill_catalog=42, bridges=15, operational=6,
    tools_registered=12, tools_active=10, mcp_servers=3,
    clients_indexed=4, projects_bridged=3,
    memory_entries=22, runtime_knowledge='loaded',
    brain_os_phase=4, brain_os_status='running',
    tg_configured=True, tg_notifier=True, tg_digest=True, tg_last='2026-07-16T08:18:00Z',
    cu_configured=False, cu_state='not_configured', cu_policies=26,
    health='healthy',
):
    return {
        'schema_version': 1,
        'generated_at': '2026-07-16T12:00:00Z',
        'source_root': '/var/lib/goviral-archon/workspaces/goviral-brain',
        'refresh_duration_ms': 250,
        'health': health,
        'warnings': [],
        'summary': {
            'agents': {
                'registered': registered,
                'discovered_definitions': registered + 1,
                'registry_drift': registry_drift,
                'workers': 5,
                'gates': 3,
                'orchestrators': 2,
                'enabled': enabled,
                'active_now': active_now,
                'runs_24h': runs_24h,
            },
            'skills': {
                'catalog': skill_catalog,
                'canonical': 50,
                'bridges': bridges,
                'operational': operational,
                'total_skill_md': 60,
            },
            'tools': {
                'registered': tools_registered,
                'active': tools_active,
                'mcp_servers': mcp_servers,
            },
            'clients': {
                'indexed': clients_indexed,
                'directories': 5,
                'runtime_knowledge_clients': 2,
                'runtime_knowledge_files': 8,
                'drift': 0,
            },
            'projects': {
                'bridged': projects_bridged,
            },
            'memory': {
                'brain_memory_entries': memory_entries,
                'knowledge_graph': 'active',
                'learning_engine': 'idle',
                'runtime_knowledge': runtime_knowledge,
            },
            'brain_os': {
                'phase': brain_os_phase,
                'status': brain_os_status,
            },
            'telegram': {
                'configured': tg_configured,
                'notifier_active': tg_notifier,
                'digest_active': tg_digest,
                'last_delivery': tg_last,
            },
            'clickup': {
                'configured': cu_configured,
                'state': cu_state,
                'policies': cu_policies,
            },
            'drift_count': drift_count,
        },
    }


def make_agents_response(
    registered_count=8, enabled_count=7, active_run_count=2,
    runs_today_count=5, recent_run_count=3, drift_count=1,
    runs=None, drift_items=None,
):
    if runs is None:
        runs = [
            {
                'id': 'thread-1',
                'title': 'Test run',
                'agent': 'iktinos',
                'status': 'completed',
                'activity': 'recent',
                'activity_inferred': True,
                'modified_at': '2026-07-16T15:30:00Z',
                'latest_event': None,
            },
        ]
    if drift_items is None:
        drift_items = [
            {
                'agent': 'herodotos',
                'issue': 'missing_registry',
                'recommendation': 'Add to registry.json',
            },
        ]
    return {
        'generated_at': '2026-07-16T12:00:00Z',
        'registered_agents': [],
        'discovered_definitions': [],
        'enabled_agents': [],
        'disabled_agents': [],
        'active_runs': [],
        'runs_today': [],
        'recent_runs': [],
        'registry_definition_drift': drift_items,
        'summary': {
            'registered_count': registered_count,
            'discovered_definition_count': registered_count + 1,
            'enabled_count': enabled_count,
            'disabled_count': registered_count - enabled_count,
            'active_run_count': active_run_count,
            'runs_today_count': runs_today_count,
            'recent_run_count': recent_run_count,
            'drift_count': drift_count,
            'total': registered_count,
            'active': active_run_count,
            'recent': recent_run_count,
            'idle': 0,
            'unknown': 0,
        },
        'runs': runs,
    }


EMPTY_OVERVIEW = {
    'doctor': {'status': 'UNKNOWN'},
    'latest_prd': None,
}

EMPTY_INCIDENTS = {
    'incidents': [],
}


class TestAgentSemantics(unittest.TestCase):
    """Test 1: Correct registered-agent semantics."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_registered_from_brain_not_thread_count(self, *_mocks):
        brain = make_brain_overview(registered=8, enabled=7)
        agents = make_agents_response(registered_count=8, enabled_count=7)

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertIn('Registered: 8', digest)
        self.assertIn('Enabled: 7', digest)
        self.assertIn('Disabled: 1', digest)
        # Must NOT show thread count as registered count
        self.assertNotIn('Registered: 0', digest)


class TestZeroRunState(unittest.TestCase):
    """Test 2: Zero-run state."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_zero_runs(self, *_mocks):
        brain = make_brain_overview(active_now=0, runs_24h=0)
        agents = make_agents_response(
            active_run_count=0, runs_today_count=0, recent_run_count=0,
            runs=[],
        )

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertIn('Active now: 0', digest)
        self.assertIn('Runs today: 0', digest)
        self.assertIn('Last run: —', digest)


class TestDriftState(unittest.TestCase):
    """Test 3: Drift state rendering."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_drift_items_shown(self, *_mocks):
        brain = make_brain_overview(registry_drift=2, drift_count=2)
        agents = make_agents_response(
            drift_count=2,
            drift_items=[
                {'agent': 'herodotos', 'issue': 'missing_registry', 'recommendation': '...'},
                {'agent': 'testbot', 'issue': 'missing_policy', 'recommendation': '...'},
            ],
        )

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertIn('Drift: 2', digest)
        self.assertIn('herodotos', digest)
        self.assertIn('testbot', digest)
        self.assertIn('Drift items:', digest)


class TestPartialSnapshotFailure(unittest.TestCase):
    """Test 4: Partial snapshot failure — empty Brain overview."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_empty_brain_overview(self, *_mocks):
        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return {}  # Brain snapshot unavailable
            if '/agents' in endpoint:
                return make_agents_response()
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        # Should still produce a valid message without crashing
        self.assertIn('GoViral Daily Ops Report', digest)
        self.assertIn('Agents', digest)
        # Graceful fallback to agent API values
        self.assertIn('Registered:', digest)

    @patch.object(report, 'api_get', return_value={})
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_all_apis_down(self, *_mocks):
        """All API endpoints return empty — report still renders."""
        digest = report.build_digest()
        self.assertIn('GoViral Daily Ops Report', digest)
        self.assertIn('Agents', digest)
        self.assertIn('Brain Inventory', digest)


class TestMessageLengthBounding(unittest.TestCase):
    """Test 5: Message-length bounding."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_within_telegram_limit(self, *_mocks):
        brain = make_brain_overview()
        agents = make_agents_response()

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertLessEqual(len(digest), report.MAX_MESSAGE_LENGTH)

    def test_truncated_with_marker(self):
        """Force truncation by directly testing build_digest with a long output."""
        # Save and restore MAX_MESSAGE_LENGTH to force truncation at a low limit
        original_max = report.MAX_MESSAGE_LENGTH
        report.MAX_MESSAGE_LENGTH = 200

        brain = make_brain_overview()
        agents = make_agents_response()

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        with patch.object(report, 'api_get') as mock_api_fn, \
             patch.object(report, 'load_json', return_value={}), \
             patch.object(report, 'backup_age_hours', return_value=None), \
             patch.object(report, 'failed_units', return_value=[]), \
             patch.object(report, 'latest_file_in', return_value={}):

            def mock_api(endpoint):
                if 'brain/overview' in endpoint:
                    return brain
                if '/agents' in endpoint:
                    return agents
                if 'overview' in endpoint:
                    return EMPTY_OVERVIEW
                if 'incidents' in endpoint:
                    return EMPTY_INCIDENTS
                return {}

            mock_api_fn.side_effect = mock_api
            report.api_get = mock_api
            try:
                digest = report.build_digest()
            finally:
                report.MAX_MESSAGE_LENGTH = original_max

        self.assertLessEqual(len(digest), 200)
        self.assertIn('[truncated]', digest)


class TestSecretRedaction(unittest.TestCase):
    """Test 6: Secret redaction."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_no_secrets_in_digest(self, *_mocks):
        brain = make_brain_overview()
        agents = make_agents_response()

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        # No credential paths
        self.assertNotIn('/etc/goviral/credentials', digest)
        self.assertNotIn('telegram-bot-token', digest)
        self.assertNotIn('telegram-chat-id', digest)
        # No token patterns
        self.assertNotIn('bot_token', digest)
        self.assertNotIn('chat_id=', digest)
        # No env contents
        self.assertNotIn('ANTHROPIC_API_KEY', digest)
        self.assertNotIn('.env', digest)


class TestBackwardCompatibility(unittest.TestCase):
    """Test 7: Backward compatibility with v2 agent summary."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_v2_only_agent_summary(self, *_mocks):
        """When Brain overview is empty, falls back to v2 agent summary fields."""
        v2_agents = {
            'generated_at': '2026-07-16T12:00:00Z',
            'summary': {
                'total': 8,
                'active': 2,
                'recent': 3,
                'idle': 2,
                'unknown': 1,
            },
            'runs': [
                {
                    'id': 'thread-1',
                    'title': 'Test',
                    'agent': 'iktinos',
                    'status': 'completed',
                    'activity': 'recent',
                    'activity_inferred': True,
                    'modified_at': '2026-07-16T15:30:00Z',
                    'latest_event': None,
                },
            ],
        }

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return {}  # No Brain API
            if '/agents' in endpoint:
                return v2_agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        # Should use v2 total as registered fallback
        self.assertIn('Registered: 8', digest)
        self.assertIn('Active now: 2', digest)


class TestIntegrationStates(unittest.TestCase):
    """Test 8: Integration state rendering."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_telegram_operational(self, *_mocks):
        brain = make_brain_overview(tg_configured=True, tg_notifier=True)
        agents = make_agents_response()

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertIn('Telegram: operational', digest)
        self.assertIn('installed=yes', digest)
        self.assertIn('creds=yes', digest)
        self.assertIn('timer=yes', digest)

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_clickup_not_configured(self, *_mocks):
        brain = make_brain_overview(cu_configured=False, cu_state='not_configured')
        agents = make_agents_response()

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertIn('ClickUp: not_configured', digest)
        self.assertIn('creds=no', digest)


class TestBrainInventory(unittest.TestCase):
    """Test 9: Brain inventory rendering."""

    @patch.object(report, 'api_get')
    @patch.object(report, 'load_json', return_value={})
    @patch.object(report, 'backup_age_hours', return_value=None)
    @patch.object(report, 'failed_units', return_value=[])
    @patch.object(report, 'latest_file_in', return_value={})
    def test_inventory_section(self, *_mocks):
        brain = make_brain_overview(
            skill_catalog=42, bridges=15, operational=6,
            tools_registered=12, tools_active=10, mcp_servers=3,
            clients_indexed=4, projects_bridged=3,
            memory_entries=22, runtime_knowledge='loaded',
        )
        agents = make_agents_response()

        def mock_api(endpoint):
            if 'brain/overview' in endpoint:
                return brain
            if '/agents' in endpoint:
                return agents
            if 'overview' in endpoint:
                return EMPTY_OVERVIEW
            if 'incidents' in endpoint:
                return EMPTY_INCIDENTS
            return {}

        report.api_get = mock_api
        digest = report.build_digest()

        self.assertIn('Brain Inventory', digest)
        self.assertIn('Skills: 63', digest)  # 42 + 15 + 6
        self.assertIn('42 catalog', digest)
        self.assertIn('15 bridges', digest)
        self.assertIn('Tools: 12', digest)
        self.assertIn('MCP: 3', digest)
        self.assertIn('Clients: 4 indexed', digest)
        self.assertIn('Projects: 3', digest)
        self.assertIn('Memory: 22 entries', digest)
        self.assertIn('Knowledge: loaded', digest)


if __name__ == '__main__':
    unittest.main()
