import * as core from '@actions/core'
import * as github from '@actions/github'
import { GitHubClient } from './github-client.js'

/**
 * DevEx metrics collection class - independent from DORA metrics
 */
export class DevExMetricsCollector {
  /**
   * Create a new DevEx metrics collector
   * @param {GitHubClient} githubClient - GitHub API client
   * @param {Object} options - Configuration options
   */
  constructor(githubClient, options = {}) {
    this.githubClient = githubClient
    this.options = {
      filesToIgnore: [],
      ignoreLineDeletions: false,
      ignoreFileDeletions: false,
      ...options
    }
  }

  /**
   * Collect all DevEx metrics for the current PR
   * @returns {Promise<Object>} Complete DevEx metrics data
   */
  async collectMetrics() {
    try {
      const prNumber = this.getPRNumber()
      if (!prNumber) {
        return {
          error: 'No PR context found - DevEx metrics require a pull request'
        }
      }

      core.info(`Collecting DevEx metrics for PR #${prNumber}`)

      // Collect PR size metrics
      const prSizeMetrics = await this.calculatePRSize(prNumber)

      // Collect PR maturity metrics
      const prMaturityMetrics = await this.calculatePRMaturity(prNumber)

      return {
        pr_number: prNumber,
        metrics: {
          pr_size: prSizeMetrics,
          pr_maturity: prMaturityMetrics
        },
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      core.error(`DevEx metrics collection failed: ${error.message}`)
      return {
        error: error.message
      }
    }
  }

  /**
   * Get the current PR number from GitHub context
   * @returns {number|null} PR number or null if not in PR context
   */
  getPRNumber() {
    // Check if we're in a pull request event
    if (
      github.context.eventName === 'pull_request' ||
      github.context.eventName === 'pull_request_target'
    ) {
      return github.context.payload.pull_request?.number
    }

    // Check if we're in a workflow_run event triggered by a PR
    if (github.context.eventName === 'workflow_run') {
      return github.context.payload.workflow_run?.pull_requests?.[0]?.number
    }

    return null
  }

  /**
   * Calculate PR size metrics
   * @param {number} prNumber - Pull request number
   * @returns {Promise<Object>} PR size metrics
   */
  async calculatePRSize(prNumber) {
    try {
      const prDetails = await this.githubClient.getPullRequest(prNumber)
      const prFiles = await this.githubClient.getPullRequestFiles(prNumber)

      if (!prFiles || prFiles.length === 0) {
        return {
          size: 'xs',
          category: 'size/xs',
          details: {
            total_additions: 0,
            total_deletions: 0,
            total_changes: 0,
            files_changed: 0,
            files_analyzed: 0
          }
        }
      }

      // Filter files based on ignore patterns
      const filteredFiles = this.filterFiles(prFiles)

      // Calculate size metrics
      const sizeDetails = this.calculateSizeDetails(filteredFiles)
      const sizeCategory = this.categorizePRSize(sizeDetails)

      return {
        size: sizeCategory,
        category: `size/${sizeCategory}`,
        details: sizeDetails
      }
    } catch (error) {
      core.warning(`Failed to calculate PR size: ${error.message}`)
      return {
        size: 'unknown',
        category: 'size/unknown',
        details: {
          error: error.message
        }
      }
    }
  }

  /**
   * Filter files based on ignore patterns
   * @param {Array} files - Array of PR file objects
   * @returns {Array} Filtered files
   */
  filterFiles(files) {
    if (!this.options.filesToIgnore.length) {
      return files
    }

    return files.filter((file) => {
      // Check if file matches any ignore pattern
      const shouldIgnore = this.options.filesToIgnore.some((pattern) => {
        // Convert glob pattern to regex (basic implementation)
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
        const regex = new RegExp(`^${regexPattern}$`)
        return regex.test(file.filename)
      })

      if (shouldIgnore) {
        core.debug(`Ignoring file: ${file.filename}`)
        return false
      }

      // Check if we should ignore deleted files
      if (this.options.ignoreFileDeletions && file.status === 'removed') {
        core.debug(`Ignoring deleted file: ${file.filename}`)
        return false
      }

      return true
    })
  }

  /**
   * Calculate detailed size metrics from filtered files
   * @param {Array} files - Filtered PR files
   * @returns {Object} Size details
   */
  calculateSizeDetails(files) {
    let totalAdditions = 0
    let totalDeletions = 0
    let filesChanged = files.length

    files.forEach((file) => {
      totalAdditions += file.additions || 0

      if (!this.options.ignoreLineDeletions) {
        totalDeletions += file.deletions || 0
      }
    })

    const totalChanges = totalAdditions + totalDeletions

    return {
      total_additions: totalAdditions,
      total_deletions: totalDeletions,
      total_changes: totalChanges,
      files_changed: filesChanged,
      files_analyzed: files.length
    }
  }

  /**
   * Categorize PR size based on change metrics
   * @param {Object} sizeDetails - Size details object
   * @returns {string} Size category (xs, s, m, l, xl)
   */
  categorizePRSize(sizeDetails) {
    const { total_changes } = sizeDetails

    // Define size thresholds based on common PR size conventions
    if (total_changes <= 10) return 'xs'
    if (total_changes <= 50) return 's'
    if (total_changes <= 200) return 'm'
    if (total_changes <= 500) return 'l'
    return 'xl'
  }

  /**
   * Calculate PR maturity metrics
   * @param {number} prNumber - Pull request number
   * @returns {Promise<Object>} PR maturity metrics
   */
  async calculatePRMaturity(prNumber) {
    try {
      const prDetails = await this.githubClient.getPullRequest(prNumber)
      if (!prDetails) {
        return {
          maturity_ratio: null,
          maturity_percentage: null,
          details: {
            error: 'Could not fetch PR details'
          }
        }
      }

      const prCommits = await this.githubClient.getPullRequestCommits(prNumber)
      if (!prCommits || prCommits.length === 0) {
        return {
          maturity_ratio: null,
          maturity_percentage: null,
          details: {
            error: 'No commits found in PR'
          }
        }
      }

      // Find the first commit (when PR was initially created/published)
      const firstCommit = prCommits[0]
      const lastCommit = prCommits[prCommits.length - 1]

      // If there's only one commit, maturity is 100% (no changes after publication)
      if (prCommits.length === 1) {
        const prFiles = await this.githubClient.getPullRequestFiles(prNumber)
        const filteredFiles = this.filterFiles(prFiles || [])
        const sizeDetails = this.calculateSizeDetails(filteredFiles)

        return {
          maturity_ratio: 1.0,
          maturity_percentage: 100,
          details: {
            total_commits: 1,
            total_changes: sizeDetails.total_changes,
            changes_after_publication: 0,
            stable_changes: sizeDetails.total_changes,
            first_commit_sha: firstCommit.sha,
            last_commit_sha: lastCommit.sha
          }
        }
      }

      // Get the diff between the first commit and the final state
      const totalDiff = await this.githubClient.compareCommitsDiff(
        firstCommit.sha,
        lastCommit.sha
      )

      if (!totalDiff) {
        return {
          maturity_ratio: null,
          maturity_percentage: null,
          details: {
            error: 'Could not compare commits'
          }
        }
      }

      // Calculate total changes in the entire PR
      const prFiles = await this.githubClient.getPullRequestFiles(prNumber)
      const filteredFiles = this.filterFiles(prFiles || [])
      const totalPRChanges = this.calculateSizeDetails(filteredFiles)

      // Calculate changes made after the first commit (changes after publication)
      const changesAfterPublication = this.calculateDiffSize(
        totalDiff.files || []
      )

      // Calculate maturity ratio
      const stableChanges = Math.max(
        0,
        totalPRChanges.total_changes - changesAfterPublication
      )
      const maturityRatio =
        totalPRChanges.total_changes > 0
          ? stableChanges / totalPRChanges.total_changes
          : 1.0
      const maturityPercentage = Math.round(maturityRatio * 100)

      return {
        maturity_ratio: Math.round(maturityRatio * 1000) / 1000, // Round to 3 decimal places
        maturity_percentage: maturityPercentage,
        details: {
          total_commits: prCommits.length,
          total_changes: totalPRChanges.total_changes,
          changes_after_publication: changesAfterPublication,
          stable_changes: stableChanges,
          first_commit_sha: firstCommit.sha,
          last_commit_sha: lastCommit.sha
        }
      }
    } catch (error) {
      core.warning(`Failed to calculate PR maturity: ${error.message}`)
      return {
        maturity_ratio: null,
        maturity_percentage: null,
        details: {
          error: error.message
        }
      }
    }
  }

  /**
   * Calculate the size of changes in a diff
   * @param {Array} files - Array of file diff objects
   * @returns {number} Total number of changes
   */
  calculateDiffSize(files) {
    let totalChanges = 0

    files.forEach((file) => {
      // Apply the same filtering logic as for PR size
      if (this.options.filesToIgnore.length > 0) {
        const shouldIgnore = this.options.filesToIgnore.some((pattern) => {
          const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
          const regex = new RegExp(`^${regexPattern}$`)
          return regex.test(file.filename)
        })

        if (shouldIgnore) {
          return
        }
      }

      if (this.options.ignoreFileDeletions && file.status === 'removed') {
        return
      }

      totalChanges += file.additions || 0

      if (!this.options.ignoreLineDeletions) {
        totalChanges += file.deletions || 0
      }
    })

    return totalChanges
  }

  /**
   * Add PR comment with size and maturity information
   * @param {number} prNumber - Pull request number
   * @param {Object} prSizeMetrics - PR size metrics
   * @param {Object} prMaturityMetrics - PR maturity metrics (optional)
   * @returns {Promise<void>}
   */
  async addPRComment(prNumber, prSizeMetrics, prMaturityMetrics = null) {
    try {
      const { size, details } = prSizeMetrics
      const sizeEmoji = this.getSizeEmoji(size)

      let comment = `## ${sizeEmoji} PR Size: ${size.toUpperCase()}

This pull request has been automatically categorized as **${size}** based on the following metrics:

- **Lines added:** ${details.total_additions}
- **Lines removed:** ${details.total_deletions}
- **Total changes:** ${details.total_changes}
- **Files changed:** ${details.files_changed}`

      // Add PR maturity information if available
      if (prMaturityMetrics && prMaturityMetrics.maturity_percentage !== null) {
        const maturityEmoji = this.getMaturityEmoji(
          prMaturityMetrics.maturity_percentage
        )
        const maturityLevel = this.getMaturityLevel(
          prMaturityMetrics.maturity_percentage
        )

        comment += `

## ${maturityEmoji} PR Maturity: ${prMaturityMetrics.maturity_percentage}%

This pull request has a **${maturityLevel}** maturity rating based on code stability:

- **Maturity ratio:** ${prMaturityMetrics.maturity_ratio}
- **Total commits:** ${prMaturityMetrics.details?.total_commits || 'N/A'}
- **Stable changes:** ${prMaturityMetrics.details?.stable_changes || 'N/A'}
- **Changes after publication:** ${prMaturityMetrics.details?.changes_after_publication || 'N/A'}`
      }

      comment += `

*This comment was generated automatically by the Agile Metrics Action.*`

      await this.githubClient.createPRComment(prNumber, comment)
      core.info(`Added DevEx comment to PR #${prNumber}`)
    } catch (error) {
      core.warning(`Failed to add PR comment: ${error.message}`)
    }
  }

  /**
   * Add size label to PR
   * @param {number} prNumber - Pull request number
   * @param {string} sizeCategory - Size category (e.g., 'size/m')
   * @returns {Promise<void>}
   */
  async addPRLabel(prNumber, sizeCategory) {
    try {
      await this.githubClient.addPRLabel(prNumber, sizeCategory)
      core.info(`Added label '${sizeCategory}' to PR #${prNumber}`)
    } catch (error) {
      core.warning(`Failed to add PR label: ${error.message}`)
    }
  }

  /**
   * Get emoji for size category
   * @param {string} size - Size category
   * @returns {string} Emoji representation
   */
  getSizeEmoji(size) {
    const emojiMap = {
      xs: '🤏',
      s: '🔹',
      m: '🔸',
      l: '🔶',
      xl: '🔥'
    }
    return emojiMap[size] || '❓'
  }

  /**
   * Get emoji for PR maturity percentage
   * @param {number} percentage - Maturity percentage (0-100)
   * @returns {string} Emoji representation
   */
  getMaturityEmoji(percentage) {
    if (percentage === null || percentage === undefined) return '❓'
    if (percentage >= 90) return '🎯'
    if (percentage >= 75) return '✅'
    if (percentage >= 50) return '⚠️'
    if (percentage >= 25) return '🚧'
    return '❌'
  }

  /**
   * Get maturity level description
   * @param {number} percentage - Maturity percentage (0-100)
   * @returns {string} Maturity level description
   */
  getMaturityLevel(percentage) {
    if (percentage === null || percentage === undefined) return 'Unknown'
    if (percentage >= 90) return 'Excellent'
    if (percentage >= 75) return 'Good'
    if (percentage >= 50) return 'Moderate'
    if (percentage >= 25) return 'Poor'
    return 'Very Poor'
  }
}
