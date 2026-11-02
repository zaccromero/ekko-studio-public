export type MentionOption = {
    key: string
    type: 'all' | 'allone' | 'agent'
    name: string
    participantId?: string
    label: string
    description: string
}

type MentionAgent = {
    name: string
    id?: string
    agentId?: string
    profile?: string
    connectionStatus?: 'online' | 'offline'
}

function isReservedMentionName(name: string): boolean {
    const normalized = name.trim().toLowerCase()
    return normalized === 'all' || normalized === 'allone'
}

export function buildMentionOptions(
    agents: MentionAgent[],
    query: string,
    allowAll = true,
    allDescription = '',
): MentionOption[] {
    const normalizedQuery = query.trim().toLowerCase()
    const options: MentionOption[] = []

    if (allowAll && (!normalizedQuery || 'all'.includes(normalizedQuery))) {
        options.push({
            key: 'special:all',
            type: 'all',
            name: 'all',
            label: '@all',
            description: allDescription,
        })
    }
    // @allone is routed from the message text (one merged team answer), so it
    // inserts text only and never becomes a structured mention.
    if (allowAll && normalizedQuery && 'allone'.includes(normalizedQuery) && normalizedQuery !== 'all') {
        options.push({
            key: 'special:allone',
            type: 'allone',
            name: 'allone',
            label: '@allone',
            description: '',
        })
    }

    for (const agent of agents) {
        if (agent.connectionStatus === 'offline') continue
        const agentName = agent.name || ''
        if (isReservedMentionName(agentName)) continue
        if (!agentName.toLowerCase().includes(normalizedQuery)) continue
        options.push({
            key: `agent:${agent.agentId || agent.id || agentName}`,
            type: 'agent',
            name: agentName,
            participantId: agent.agentId || agent.id,
            label: `@${agentName}`,
            description: agent.profile || '',
        })
    }

    return options
}
